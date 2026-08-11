import * as path from "node:path";
import type * as z from "zod";
import {
	buildCoverageReport,
	buildPageObjectTree,
	buildTestIdTree,
	type ComponentInfo,
	type CoverageBucket,
	type Diagnostic,
	discoverPageObjects,
	entryFileCandidates,
	isCatchAllPattern,
	matchEntryPath,
	nearestFiles,
	nearestIds,
	nearestNames,
	normalizeRelPath,
	type PageObjectSummary,
	type SelectorInfo,
	scannedComponents,
	type TestIdOccurrence,
	type UiNode,
	type UiUnresolvedReason,
	type Workspace,
} from "../analysis";
import { apiHintsFor } from "./api";
import { hintForSuggestions, ToolError } from "./errors";
import {
	type CoverageHandles,
	HANDLE_LIFETIME_TEXT,
	handleFailureMessage,
} from "./handles";
import type { McpServerOptions } from "./options";
import { renderPageObjectOutline, renderTestIdOutline } from "./outline";
import {
	envelopeBytes,
	fitBuckets,
	MAX_ERROR_LIST,
	MAX_RESPONSE_BYTES,
	ok,
	type TextResult,
	type ToolMeta,
} from "./respond";
import {
	COVERAGE_BUCKETS,
	type getPageObjectTreeInput,
	type getTestIdTreeInput,
	type listPageObjectsInput,
	type mapCoverageInput,
	type queryCoverageInput,
} from "./schemas";
import { planWarnings, type WarningLedger } from "./warnings";

/**
 * The per-server state a tool call may consult. Optional throughout: a handler
 * called without one behaves exactly as it did before sessions existed, which
 * is what keeps the direct-call tests honest about the payload shape.
 */
export interface ToolSession {
	warnings?: WarningLedger;
}

/**
 * Thin tool handlers: validate cross-field rules, call the analysis engine,
 * shape a token-lean payload, wrap in the response envelope.
 */

/**
 * Turns an environment diagnostic into the flag that fixes it.
 *
 * The engine deliberately names no CLI option — it is consumed by more than one
 * surface — but an agent holding a wrong answer needs a concrete next move, and
 * "the attribute is wrong" without "restart with `--attribute data-tid`" is a
 * dead end. This is the one place that translation happens, and it goes in
 * front of every per-tool hint: no advice about which tool to call next matters
 * while the analysis is reading the wrong attribute.
 */
export function environmentHint(
	warnings: Diagnostic[] | undefined,
): string | undefined {
	if (!warnings || warnings.length === 0) {
		return undefined;
	}
	const byCode = (code: string): Diagnostic | undefined =>
		warnings.find((warning) => warning.code === code);

	const mismatch = byCode("attribute-mismatch");
	if (mismatch) {
		const candidate = String(mismatch.data?.candidate ?? "");
		return `The test-id attribute is almost certainly wrong: nothing in the scanned sources uses "${mismatch.data?.attribute}", while "${candidate}" is everywhere. Restart the server with --attribute ${candidate}, or with --playwright-config <file> pointing at the config that sets use.testIdAttribute. Treat this result as unreliable until then.`;
	}

	const blind = byCode("scope-empty") ?? byCode("attribute-no-evidence");
	if (blind) {
		return blind.code === "scope-empty"
			? "No JSX/TSX sources were scanned, so no rendered test id can be found and every selector will look unmatched. Restart the server with --src-dir <dir> (or --project-root <dir>) covering the application sources."
			: `No element in the scanned sources uses the "${blind.data?.attribute}" attribute. Restart the server with --src-dir <dir> so the application sources are in scope, or with --attribute <name> if the sources use a different one.`;
	}

	const missing = warnings.find(
		(warning) =>
			warning.code === "scope-dir-missing" && warning.severity !== "info",
	);
	if (missing) {
		return `The scanned directory "${missing.data?.path}" does not exist, so the analysis saw less than you think. Restart the server with a --src-dir that is on disk.`;
	}

	const ambiguous = warnings.find(
		(warning) =>
			warning.code === "playwright-config-ambiguous" &&
			warning.severity === "warning",
	);
	if (ambiguous) {
		return `${ambiguous.data?.count} Playwright configs were found and none of them sets use.testIdAttribute; ${ambiguous.data?.chosen} was read. If the attribute lives elsewhere, restart the server with --playwright-config <file>.`;
	}

	const conflict = byCode("testid-attribute-conflict");
	if (conflict) {
		return `Two Playwright configs disagree about use.testIdAttribute. Restart the server with --playwright-config <file> to pin the one your tests run with.`;
	}

	// Last, and only at warning severity — that is the run with dead selectors in
	// it, where the reader is about to act on a list the scope makes unreliable.
	// It also names the one flag that works: `--src-dir` outside `--project-root`
	// is refused at startup (validateServerOptions), so the natural reading of
	// "add their directories to the scan" is advice that kills the server.
	const scope = warnings.find(
		(warning) =>
			warning.code === "ui-scope-incomplete" && warning.severity === "warning",
	);
	const sourceRoot = scope?.data?.sourceRoot;
	if (typeof sourceRoot === "string") {
		return `Dead selectors in this report are unverified: ${scope?.data?.tags} component tag(s) render from modules whose sources live at "${sourceRoot}", outside this server's --project-root. Restart with --project-root ${sourceRoot} to include them. Adding them with --src-dir will not work — a --src-dir outside the project root is refused at startup.`;
	}

	// Its sibling above names `--project-root` exactly and even pre-empts the
	// wrong flag; this one said "re-run assuming forwarding" and named nothing,
	// so the one piece of advice a reader could not act on was the one whose fix
	// is a single flag. It is a startup flag, not a tool argument, which is the
	// part a caller cannot guess and would waste a call discovering.
	const forwarding = byCode("forwarding-unproven-widespread");
	if (forwarding) {
		return `${forwarding.data?.unproven} of ${forwarding.data?.selectors} test-id selector(s) match only ids written as component props, which is what a component library that forwards props as a matter of course looks like. If yours does, restart the server with --assume-forwarded to count them as matches; it is a server flag, not a tool argument, so it needs a restart. Every id and match it changes is labelled in the response.`;
	}

	return undefined;
}

/**
 * Warnings minus the ones that describe a node tree, for a response that ships
 * none.
 *
 * `tree-partial` says where the *walk* stopped, in terms of `roots`. It is the
 * right thing to say next to a tree and wrong next to anything else: a `testId`
 * lookup answers from the flat inventory, which is complete in every fidelity
 * mode, so the caveat lands on the one part of the analysis it does not apply
 * to. The same reasoning removes it from coverage, one layer down in
 * `buildCoverageReport`.
 */
function withoutTreeShapeWarnings(warnings: Diagnostic[]): Diagnostic[] {
	return warnings.filter((warning) => warning.code !== "tree-partial");
}

/** Prepends the environment hint, so it is read before any per-tool advice. */
function withEnvironmentHint(
	warnings: Diagnostic[] | undefined,
	hint: string | undefined,
): string | undefined {
	const environment = environmentHint(warnings);
	if (!environment) {
		return hint;
	}
	return hint ? `${environment} ${hint}` : environment;
}

/** Config file the analysis actually read, for `meta.playwrightConfig`. */
function configFileOf(workspace: Workspace): string | undefined {
	return workspace.playwright().configFile ?? undefined;
}

function compactSelector(selector: SelectorInfo): Record<string, unknown> {
	const compact: Record<string, unknown> = { kind: selector.kind };
	if (selector.testId !== undefined) {
		compact.testId = selector.testId;
	}
	if (selector.pattern) {
		compact.pattern = selector.pattern.source;
		// Without the flags an agent reads /cart/i as case-sensitive.
		if (selector.pattern.flags) {
			compact.patternFlags = selector.pattern.flags;
		}
	}
	if (selector.role !== undefined) {
		compact.role = selector.role;
	}
	if (selector.text !== undefined) {
		compact.text = selector.text;
	}
	if (selector.options !== undefined) {
		compact.options = selector.options;
	}
	if (selector.dynamic) {
		compact.dynamic = true;
		compact.raw = selector.raw;
	}
	return compact;
}

function summaryEntry(summary: PageObjectSummary): Record<string, unknown> {
	const entry: Record<string, unknown> = {
		name: summary.className,
		file: summary.file,
		kind: summary.hostKind,
	};
	if (summary.rootSelector) {
		entry.root = compactSelector(summary.rootSelector);
	}
	if (summary.fixtures.length > 0) {
		entry.fixtures = summary.fixtures.map((fixture) => fixture.name);
	}
	entry.members = summary.counts.members;
	entry.methods = summary.counts.methods;
	if (summary.doc) {
		entry.doc = summary.doc;
	}
	return entry;
}

const EMPTY_INDEX_HINT =
	'No classes with playwright-page-object decorators were found. If your page objects live elsewhere, restart the server with --src-dir <dir>; also check that those files import from "playwright-page-object".';

/**
 * What to say when the page came back empty.
 *
 * Three different situations produced the same "nothing was found" message, and
 * two of them were the caller's own arguments rather than the repository: a
 * filter that matched none of 305 page objects, and an offset past the end.
 * Telling either of those callers to restart the server with `--src-dir` sends
 * them to reconfigure a server that is working correctly.
 */
function listEmptyHint(
	filter: string | undefined,
	offset: number,
	total: number,
	indexed: PageObjectSummary[],
): string | undefined {
	if (indexed.length === 0) {
		return EMPTY_INDEX_HINT;
	}
	if (total === 0) {
		const nearest = nearestIds(
			filter ?? "",
			indexed.map((item) => item.className),
			5,
		);
		const suggestion =
			nearest.length > 0 ? ` Closest names: ${nearest.join(", ")}.` : "";
		return `No page object matches filter "${filter}", but the index holds ${indexed.length}. Drop or widen the filter — it is a plain case-insensitive substring of the class name or file path.${suggestion}`;
	}
	return `offset ${offset} is past the end of ${total} result(s); re-call with a smaller offset.`;
}

export function handleListPageObjects(
	workspace: Workspace,
	args: z.infer<typeof listPageObjectsInput>,
	session: ToolSession = {},
) {
	const index = discoverPageObjects(workspace);
	let items = index.pageObjects;
	if (args.filter) {
		const needle = args.filter.toLowerCase();
		items = items.filter(
			(item) =>
				item.className.toLowerCase().includes(needle) ||
				item.file.toLowerCase().includes(needle),
		);
	}
	const total = items.length;
	const offset = args.offset;
	const shown = items.slice(offset, offset + args.limit);
	const end = offset + shown.length;
	// Planned once and used everywhere below: the hint is built from the *full*
	// warnings, because `environmentHint` reads their `data`, and an abbreviated
	// warning has none. That split is the whole safety net - the advice survives
	// at full length however many times its warning has already been sent.
	const warnings = planWarnings(session.warnings, index.warnings);

	return ok(
		shown.map(summaryEntry),
		{
			root: index.projectRoot,
			attribute: index.testIdAttribute,
			attributeSource: index.testIdAttributeSource,
			playwrightConfig: configFileOf(workspace),
			scanned: index.stats.filesScanned,
			// Always, not only when it overflows: a caller who cannot tell a
			// complete list from a capped one has to re-call to find out.
			total,
			offset: offset > 0 ? offset : undefined,
			nextOffset: end < total ? end : undefined,
			warnings: warnings.shown,
			hint: withEnvironmentHint(
				index.warnings,
				shown.length === 0
					? listEmptyHint(args.filter, offset, total, index.pageObjects)
					: undefined,
			),
		},
		{
			shrinkHint:
				"Re-call with a lower `limit`, a narrower `filter`, or page through with `offset`.",
			onDelivered: warnings.delivered,
		},
	);
}

/** Characters that make a value look like an absolute path on either OS. */
function isAbsoluteLike(value: string): boolean {
	return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Accepts an absolute path that points inside the project, and refuses one that
 * does not.
 *
 * Agents paste the path their editor shows them. Treating
 * `C:\repo\e2e\Home.ts` as a relative path made it match nothing and produced
 * `file_not_found` with a list of relative suggestions — technically correct,
 * unactionable in practice. A path outside the root is a different mistake and
 * gets a different answer rather than a silent miss.
 */
function relativizeFile(
	workspace: Workspace,
	file: string,
): { file: string; note?: string } {
	if (!isAbsoluteLike(file)) {
		return { file };
	}
	const root = normalizeRelPath(workspace.root).replace(/\/+$/, "");
	const posix = normalizeRelPath(file);
	if (foldFile(posix) === foldFile(root)) {
		throw new ToolError("invalid_input", `"${file}" is the project root.`, {
			hint: "Pass the path of a file, relative to the project root.",
		});
	}
	if (foldFile(posix).startsWith(`${foldFile(root)}/`)) {
		const relative = posix.slice(root.length + 1);
		return {
			file: relative,
			note: `\`file\` was given as an absolute path and read as "${relative}", relative to the project root.`,
		};
	}
	throw new ToolError(
		"invalid_input",
		`"${file}" is outside the analysed project root (${root}).`,
		{
			hint: "Paths are workspace-relative. Pass the path exactly as list_page_objects reports it, or restart the server with --project-root covering that file.",
		},
	);
}

export function handleGetPageObjectTree(
	workspace: Workspace,
	args: z.infer<typeof getPageObjectTreeInput>,
	session: ToolSession = {},
) {
	if (!args.class && !args.file) {
		throw new ToolError("invalid_input", "Provide `class`, `file`, or both.", {
			hint: 'Pass class (e.g. "CheckoutPage") or file. Call list_page_objects to see both.',
		});
	}

	const resolved = args.file
		? relativizeFile(workspace, args.file)
		: { file: undefined, note: undefined };

	const target =
		args.class && resolved.file
			? `${resolved.file}#${args.class}`
			: (args.class ?? resolved.file ?? "");

	const tree = buildPageObjectTree(workspace, target, {
		maxDepth: args.depth,
	});

	// Copied, never trimmed in place. The engine memoizes the tree and hands the
	// same object to every caller, so dropping the methods here would delete them
	// for the next call that asks for them — a response that silently loses a
	// section because an earlier call in the session passed includeMethods:false.
	const shown = args.includeMethods
		? tree
		: {
				...tree,
				defs: Object.fromEntries(
					Object.entries(tree.defs).map(([id, def]) => [
						id,
						{ ...def, methods: [] },
					]),
				),
			};

	const warnings = planWarnings(session.warnings, tree.warnings);
	// The same once-per-session rule the warnings beside it follow. It was 52% of
	// a small tree response and identical on every call; a repeat keeps the keys,
	// which name the bases in play, and drops the prose.
	const api = session.warnings
		? session.warnings.planText("apiHints", apiHintsFor(tree))
		: { shown: apiHintsFor(tree), delivered: () => {} };
	// Two fields, each with one type, rather than one field that changes type
	// between calls. `apiHints` is always the object of prose or absent; a repeat
	// puts the base names in `apiHintsSent` instead. A consumer that reads the
	// prose keeps a stable contract, and the repeat still costs a line.
	const apiFull = Array.isArray(api.shown) ? undefined : api.shown;
	const apiRepeated = Array.isArray(api.shown)
		? (api.shown as string[])
		: undefined;
	const meta = {
		root: tree.projectRoot,
		attribute: tree.testIdAttribute,
		attributeSource: tree.testIdAttributeSource,
		playwrightConfig: configFileOf(workspace),
		note: resolved.note,
		truncated: tree.truncated,
		// In meta, so both formats carry it: `outline` ships a string as its data,
		// and the call syntax is no less needed there. It describes how to *use*
		// what the tree found rather than being part of the finding.
		apiHints: apiFull,
		// Named for what it is: these bases were explained in full earlier this
		// session, so the prose is not repeated.
		apiHintsSent: apiRepeated,
		warnings: warnings.shown,
		hint: environmentHint(tree.warnings),
	};

	const shrink = {
		shrinkHint: `Re-call with format:"outline", a lower depth (this call used ${args.depth}), or includeMethods:false.`,
		onDelivered: () => {
			warnings.delivered();
			api.delivered();
		},
	};

	if (args.format === "outline") {
		return ok(renderPageObjectOutline(shown), meta, shrink);
	}

	return ok(
		{ root: shown.root, defs: shown.defs, stats: shown.stats },
		meta,
		shrink,
	);
}

/**
 * Why a tree is not worth sending, or `undefined` when it is.
 *
 * A run whose attribute does not appear in the sources builds a real tree of
 * real components in which *every* node is id-less — 11 KB, on a repository
 * where the answer is "you are reading the wrong attribute". The environment
 * warning and `meta.hint` already say that, in full, and they are what the
 * caller has to act on; the nodes add nothing to them.
 *
 * Deliberately narrow. It fires only when the analysis has *proven* the payload
 * is empty of answers: an environment diagnostic that invalidates the whole
 * scan, and not one id anywhere in the tree. A tree with a single id is shipped
 * whole, because then the reader has something to check the warning against.
 */
function blindScan(
	warnings: Diagnostic[],
	roots: UiNode[],
	gap: TreeGap | null,
): string | undefined {
	const hasId = (nodes: UiNode[]): boolean =>
		nodes.some((node) => node.testId !== undefined || hasId(node.children));
	if (roots.length === 0 || hasId(roots)) {
		return undefined;
	}

	const blinding = warnings.find(
		(warning) =>
			warning.code === "attribute-mismatch" ||
			warning.code === "attribute-no-evidence",
	);
	if (blinding) {
		return `Not one node in this tree carries a test id, because ${blinding.code}: this run read an attribute the sources do not use. The nodes were omitted rather than sent as an id-less shell - read the warning and the hint, fix the attribute, and re-call.`;
	}

	// The same shape from a different cause, and the expensive one in practice.
	// Rooting at a page component whose content sits behind a router or a
	// provider wall walks hundreds of scaffolding nodes and reaches no id at
	// all: 43 KB on the measured page, of which none was an answer. A *complete*
	// tree with no ids is a real finding and still ships - "this component
	// renders none" is worth knowing. A cut one proves nothing and costs most.
	if (gap) {
		return `This tree reached no test id at all, and the walk is incomplete (${gap.detail}), so its nodes prove nothing about what renders here - they were omitted. Pass testId to look an id up across the whole scan, which is complete whatever the walk did, and root a new tree at the file it names.`;
	}
	return undefined;
}

/** Ids named in a capped list, plus how many more there were. */
interface IdsNotPlaced {
	ids: string[];
	total: number;
}

/** A short list is for reading; past this the count carries it. */
const MAX_UNPLACED_IDS = 12;

/**
 * Ids the walk read out of the files it visited but did not put in the tree.
 *
 * A partial tree says "293 of 375 nodes were left unexpanded", which is a
 * count, not a list — so an agent cannot tell "this id does not exist" from
 * "the walk did not reach it", and the whole promise of the tool is that
 * absence means something. Measured: a tree rooted at `GuestsList.tsx` reported
 * ids from lines 29–50 of a component file and silently omitted two from lines
 * 18 and 23 of that same file, which `map_coverage` located exactly.
 *
 * Scoped to files the tree actually walked, deliberately. Scan-wide this would
 * be ~1,500 entries on a real repository and useless; restricted this way it is
 * short, exact, and answers the question that was asked. The inventory is
 * complete in every fidelity mode, so this is a set difference over data the
 * response already holds — no extra analysis.
 */
function idsNotPlaced(
	roots: UiNode[],
	inventory: TestIdOccurrence[],
): IdsNotPlaced | undefined {
	const walkedFiles = new Set<string>();
	const placed = new Set<string>();
	const visit = (nodes: UiNode[]): void => {
		for (const node of nodes) {
			walkedFiles.add(node.file);
			// Both halves of a static choice. `data-testid={flag ? "Main" : "Alt"}`
			// keeps `Main` in `testId` and `Alt` in `testIdAlternatives`, and the
			// inventory holds both — so counting only the first reported `Alt` as an
			// id the tree failed to place while it was sitting on that very node.
			for (const value of [node.testId, ...(node.testIdAlternatives ?? [])]) {
				if (value?.kind === "static" && value.value !== undefined) {
					placed.add(value.value);
				}
			}
			visit(node.children);
		}
	};
	visit(roots);
	if (walkedFiles.size === 0) {
		return undefined;
	}

	const missing = new Set<string>();
	for (const occurrence of inventory) {
		if (
			occurrence.value.kind === "static" &&
			occurrence.value.value !== undefined &&
			walkedFiles.has(occurrence.file) &&
			!placed.has(occurrence.value.value)
		) {
			missing.add(occurrence.value.value);
		}
	}
	if (missing.size === 0) {
		return undefined;
	}
	return {
		ids: [...missing].sort().slice(0, MAX_UNPLACED_IDS),
		total: missing.size,
	};
}

/** What a `testId` lookup should say beyond the occurrence list itself. */
function lookupHint(
	needle: string,
	found: number,
	catchAllSkipped: number,
	propOnly: boolean,
	families: string[] = [],
): string | undefined {
	if (found === 0) {
		const quarantined =
			catchAllSkipped > 0
				? ` ${catchAllSkipped} element(s) do write the attribute with a value built entirely at runtime, which would match any id and so proves nothing about this one; they are excluded.`
				: "";
		// The one true-negative that reads like a bug. A `@ListSelector("Row")`
		// matches ids rendered as `Row_1`, `Row_2`, ... and coverage counts it
		// matched, while looking the bare prefix up is correctly empty — nothing
		// renders `Row` itself. Saying only "not found" invites the reader to
		// conclude the selector is broken.
		if (families.length > 0) {
			return `No element renders the exact id "${needle}", but ${families.length === 1 ? "an id family" : "id families"} built on it ${families.length === 1 ? "does" : "do"}: ${families.join(", ")}. A prefix selector such as @ListSelector("${needle}") matches those and is not dead. Look up a concrete one (for example "${needle}_0"), or call get_testid_tree on the component to see them in place.`;
		}
		return `No rendered element with test id "${needle}" was found.${quarantined} Call get_testid_tree without testId to see the full tree, or map_coverage to check for renamed ids.`;
	}
	if (propOnly) {
		return `Every occurrence of "${needle}" is written as a prop on a component tag, and nothing proved the component forwards it to a host element. It may not exist in the DOM at all; check the component before writing a selector for it.`;
	}
	return undefined;
}

/**
 * The `file` argument, resolved to the path the walk will root at.
 *
 * `TestIdTreeOptions.entry` is a path the engine looks for among the scanned
 * JSX sources, and a path that matches none of them is not an error down there:
 * the walk reports `entry-not-found` and falls back to a flat inventory of the
 * whole scan. Through this tool that reads as "your scope was ignored, here is
 * the entire repository" — one typo'd `file` in the field produced a `too_large`
 * failure whose advice was to scope the call with `file`, which the caller had
 * already done. So the same resolve-then-refuse the other two tools apply to
 * their `file` argument happens here, against the very set the engine searches.
 *
 * Through {@link matchEntryPath}, which is the engine's own rule rather than a
 * copy of it: exact path first, a trailing segment only when it fits one file.
 * A `.find()` over the same candidates accepted whichever suffix match sorted
 * first, so `src/App.tsx` could be answered with `packages/ui/src/App.tsx` — and
 * because this wrapper rewrites the request, the engine's corrected resolver
 * never saw the path the caller actually wrote.
 */
function resolveEntryFile(
	workspace: Workspace,
	file: string,
): { file: string; note?: string } {
	const resolved = relativizeFile(workspace, file);
	const candidates = entryFileCandidates(workspace);
	const match = matchEntryPath(candidates, resolved.file);
	if (match.kind === "ambiguous") {
		throw new ToolError(
			"ambiguous_component",
			`"${file}" names only a trailing path segment, and ${match.candidates.length} scanned files end with it.`,
			{
				candidates: match.candidates,
				hint: "Re-call with `file` set to one of the candidates, spelled relative to the project root.",
			},
		);
	}
	if (match.kind === "none") {
		const suggestions = nearestFiles(resolved.file, candidates);
		const scopeAdvice =
			"Only scanned .tsx/.jsx sources can root a tree: if the file is on disk but outside the scan, restart the server with --src-dir <dir> (or --project-root <dir>) covering it.";
		throw new ToolError(
			"file_not_found",
			`No scanned .tsx/.jsx source matches "${file}".`,
			{
				suggestions,
				hint: hintForSuggestions(suggestions, {
					some: `Use one of the suggested paths, or pass \`component\` and let the server find the file. ${scopeAdvice}`,
					none: `Nothing in the scan resembles that path. Pass \`component\` and let the server find the file, or pass \`testId\` to find where a known id is rendered. ${scopeAdvice}`,
				}),
			},
		);
	}
	// The scanned spelling, not the caller's: it is what `component` is filtered
	// against below, and what the engine will match without a suffix search.
	return { file: match.file, note: resolved.note };
}

/**
 * What to say when `component` named nothing.
 *
 * Three mistakes wear the same error code, and each has a different list that
 * answers it. The name exists but not in the file that was named: the files
 * that *do* declare it are the fix, and they go in `candidates` — the same
 * answer the page-object side gives for `path.ts#ClassName` against the wrong
 * file. The name exists nowhere and a file was named: that file's own
 * components are the fix, and the whole list is short enough to be the answer.
 * The name exists nowhere and no file was named: ranking is all there is, since
 * dumping every component in the repository buries the one that matters.
 *
 * The list used to be empty in all three, which is how a one-character typo
 * became a dead end.
 */
function missingComponent(
	wanted: string,
	scopeFile: string | undefined,
	sameName: ComponentInfo[],
	all: ComponentInfo[],
): ToolError {
	if (scopeFile && sameName.length > 0) {
		return new ToolError(
			"file_not_found",
			`No component named "${wanted}" is declared in "${scopeFile}", but ${sameName.length} other file(s) declare it.`,
			{
				candidates: sameName.map((component) => component.file).sort(),
				hint: "Re-call with `file` set to one of the candidates, or drop `file` to search every scanned file.",
			},
		);
	}

	if (!scopeFile) {
		const suggestions = nearestNames(
			wanted,
			all.map((component) => component.name),
			MAX_ERROR_LIST,
		);
		return new ToolError(
			"file_not_found",
			`No component named "${wanted}" was found in the scanned sources.`,
			{
				suggestions,
				hint: hintForSuggestions(suggestions, {
					some: "Pass one of the suggested names, pass `file` with the component's path, or omit both to auto-detect the app entry.",
					none: "Nothing in the scan resembles that name. Pass `file` with the component's path, omit both to auto-detect the app entry, or pass `testId` to find where a known id is rendered.",
				}),
			},
		);
	}

	const inFile = [
		...new Set(
			all
				.filter((component) => isScannedFile(component.file, scopeFile))
				.map((component) => component.name),
		),
	].sort();
	return new ToolError(
		"file_not_found",
		inFile.length === 0
			? `"${scopeFile}" declares no components.`
			: `No component named "${wanted}" is declared in "${scopeFile}".`,
		{
			suggestions: inFile,
			hint: hintForSuggestions(inFile, {
				some: "Pass one of the suggested names, drop `file` to search every scanned file, or omit both to auto-detect the app entry.",
				none: "Pass `file` with the path of a file that declares a component, or omit both to auto-detect the app entry.",
			}),
		},
	);
}

export function handleGetTestIdTree(
	workspace: Workspace,
	args: z.infer<typeof getTestIdTreeInput>,
	session: ToolSession = {},
) {
	// `followComponents` is a real engine option now, so it no longer has to be
	// faked as `depth: 1`. That collapse reported every component boundary as
	// `depth-limit-reached` and set `truncated`, telling callers a budget had run
	// out when they had simply asked for one level.
	const depth = args.depth;
	const followComponents = args.followComponents;
	// Before anything reads it, and whatever the call goes on to ask for: a
	// `file` naming nothing is the caller's mistake in every branch.
	const scope = args.file ? resolveEntryFile(workspace, args.file) : undefined;

	if (args.testId) {
		// A lookup answers from the flat inventory, which is complete whatever the
		// walk did. `followComponents` shapes the tree, so narrowing the lookup by
		// it would answer "not rendered" about a file the walk simply skipped.
		const tree = buildTestIdTree(workspace, {
			attribute: args.attribute,
			maxDepth: depth,
		});
		const needle = args.testId;
		// A pattern that matches everything matches this too, and reporting it as
		// a hit tells a caller their id is rendered at a line where the source
		// writes `data-testid={anything}`. Counted separately so the answer can
		// say what it left out instead of pretending there was nothing.
		let catchAllSkipped = 0;
		const occurrences = tree.inventory.filter((occurrence) => {
			if (occurrence.value.kind === "static") {
				return occurrence.value.value === needle;
			}
			if (occurrence.value.kind === "pattern" && occurrence.value.regex) {
				if (isCatchAllPattern(occurrence.value.regex.source)) {
					catchAllSkipped += 1;
					return false;
				}
				return new RegExp(
					occurrence.value.regex.source,
					occurrence.value.regex.flags,
				).test(needle);
			}
			return false;
		});
		const propOnly =
			occurrences.length > 0 &&
			occurrences.every((occurrence) => occurrence.reach === "component-prop");
		// Pattern families the needle names the head of, for the empty-result hint.
		const families =
			occurrences.length > 0
				? []
				: [
						...new Set(
							tree.inventory
								.filter(
									(occurrence) =>
										occurrence.value.kind === "pattern" &&
										typeof occurrence.value.prefix === "string" &&
										occurrence.value.prefix.startsWith(needle),
								)
								.map(
									(occurrence) =>
										`${(occurrence.value as { prefix?: string }).prefix ?? ""}*`,
								),
						),
					].slice(0, 5);
		// A lookup ships occurrences, never `roots`, so `tree-partial` here
		// describes a tree the caller did not ask for and cannot see — and reads as
		// a caveat on the inventory, which is the one thing that is always
		// complete.
		const full = withoutTreeShapeWarnings(tree.warnings);
		const warnings = planWarnings(session.warnings, full);
		return ok(
			{ occurrences },
			{
				attribute: tree.attribute,
				attributeSource: tree.attributeSource,
				playwrightConfig: configFileOf(workspace),
				// "That id is not rendered anywhere" is the single most misleading
				// answer this server can give when the attribute or the scope is
				// wrong, and this branch used to ship it with no warnings at all.
				warnings: warnings.shown,
				hint: withEnvironmentHint(
					full,
					lookupHint(
						needle,
						occurrences.length,
						catchAllSkipped,
						propOnly,
						families,
					),
				),
			},
			{
				// A lookup ignores `format`, `depth`, `followComponents`, `file` and
				// `component` - it answers from the scan-wide inventory - so the hint
				// the tree branch uses names five knobs this branch does not have.
				// Exactly what `coverageShrinkHint` was written to stop, one branch
				// over.
				shrinkHint:
					"A testId lookup has no per-call size control: it answers from the whole scan, and `format`, `depth` and the `file` / `component` scope do not narrow it. Look up a more specific id, or restart the server with a narrower --src-dir / --project-root.",
				onDelivered: warnings.delivered,
			},
		);
	}

	let entry = scope?.file;
	let entryComponent: string | undefined;
	let requested: ComponentInfo | undefined;
	let siblings: ComponentInfo[] = [];
	const scopeFile = scope?.file;
	if (args.component) {
		// The component inventory, not a tree. This used to build a whole depth-1
		// tree — scanning every JSX file for ids and running a walk — and read one
		// field off it, which is a second full pass over the sources before the
		// real tree below has even started.
		const components = Object.values(scannedComponents(workspace));
		const named = components.filter(
			(component) => component.name === args.component,
		);
		// A component name is only unique per file. Narrow by `file` when the
		// caller gave one; otherwise a name two files declare is ambiguous, and
		// answering with whichever was scanned first is a guess.
		const matches = scopeFile
			? named.filter((component) => isScannedFile(component.file, scopeFile))
			: named;
		if (matches.length === 0) {
			throw missingComponent(args.component, scopeFile, named, components);
		}
		if (matches.length > 1) {
			throw new ToolError(
				"ambiguous_component",
				`${matches.length} files declare a component named "${args.component}".`,
				{
					candidates: matches.map((component) => component.file).sort(),
					hint: "Re-call with `file` set to one of the candidates.",
				},
			);
		}
		const match = matches[0];
		entry = match.file;
		// The engine roots where it is told now, so the name resolved here is the
		// name the tree comes back rooted at — no re-derivation, no sibling
		// reconciliation, no chance of answering with a component nobody asked for.
		entryComponent = match.name;
		requested = match;
		siblings = components.filter(
			(component) =>
				component.file === match.file && component.name !== match.name,
		);
	}

	const tree = buildTestIdTree(workspace, {
		attribute: args.attribute,
		entry,
		entryComponent,
		maxDepth: depth,
		followComponents,
	});

	// The engine roots where it was told. The only way a named component still
	// fails to come back is the engine refusing it outright, and its reason is
	// more specific than anything this layer could re-derive.
	if (requested && tree.fidelity === "flat") {
		throw new ToolError(
			"incomplete_tree",
			tree.fidelityReason ??
				`"${requested.name}" could not be rooted in "${requested.file}".`,
			{
				candidates: siblings.map((one) => one.name).sort(),
				hint: `Pass testId to find where "${requested.name}" is rendered, or request one of the other components in that file.`,
			},
		);
	}

	const roots = tree.roots;
	const gap = traversalGap(roots, tree.truncated === true);
	const warnings = planWarnings(session.warnings, tree.warnings);
	const blind = blindScan(tree.warnings, roots, gap);
	const meta: Record<string, unknown> = {
		attribute: tree.attribute,
		attributeSource: tree.attributeSource,
		playwrightConfig: configFileOf(workspace),
		note: scope?.note,
		fidelity: tree.fidelity,
		fidelityReason: tree.fidelityReason,
		truncated: tree.truncated,
		scanned: tree.stats.files,
		suppressed: blind,
		// Only on a holed tree: on a complete one every id in a walked file is in
		// the tree by construction, and an empty key would be noise on every call.
		idsNotPlaced: gap ? idsNotPlaced(roots, tree.inventory) : undefined,
		warnings: warnings.shown,
		// A partial tree is the normal answer for any real app, so the useful
		// thing is not the word but what to do about it. "Absent from this tree"
		// must never be read as "not rendered" while a gap is open.
		hint: withEnvironmentHint(
			tree.warnings,
			gap ? gapHint(gap, depth, followComponents) : undefined,
		),
	};

	const shrink = {
		shrinkHint: `Re-call with format:"outline", a lower depth (this call used ${depth}), or scope the walk with \`file\` or \`component\`.`,
		onDelivered: warnings.delivered,
	};

	// Nothing to read, so nothing to send. The nodes are real, but every one of
	// them is id-less because the attribute this run searched for is not the one
	// the sources write - the analysis has already proven the payload carries no
	// answer, and shipping it costs 11 KB to say so. The warning and the hint,
	// which are the actual answer, ship as always.
	if (blind) {
		return ok(
			{ fidelity: tree.fidelity, roots: [], stats: subtreeStats([]) },
			meta,
			shrink,
		);
	}

	if (args.format === "outline") {
		return ok(renderTestIdOutline(tree), meta, shrink);
	}

	if (tree.fidelity === "flat") {
		return ok({ fidelity: "flat", inventory: tree.inventory }, meta, shrink);
	}

	// Counted over `roots`, not over the scan: those are two different shapes
	// whenever the tree is rooted at one component of many, and stats describing
	// something the caller cannot see are worse than no stats. Scan-wide numbers
	// live in `meta.scanned`.
	return ok(
		{ fidelity: tree.fidelity, roots, stats: subtreeStats(roots) },
		meta,
		shrink,
	);
}

/**
 * A path as the engine spells it, folded for comparison: posix separators, no
 * leading `./`, and case folded only where the filesystem folds it too.
 */
function foldFile(value: string): string {
	const posix = normalizeRelPath(value);
	return process.platform === "win32" || process.platform === "darwin"
		? posix.toLowerCase()
		: posix;
}

/**
 * Whether an engine-emitted path is the scanned file `resolveEntryFile` picked.
 *
 * Exact, deliberately. The suffix rule that makes `Nested.tsx` stand in for
 * `src/deep/Nested.tsx` belongs to {@link matchEntryPath}, which has already run
 * by the time anything here compares paths — and applying it a second time to
 * the *result* undoes it: `src/App.tsx`, resolved exactly against the scan,
 * matched `packages/ui/src/App.tsx` again, so a monorepo that declares the
 * requested component in the package copy was answered with the package copy
 * however fully the caller spelled the path.
 */
function isScannedFile(rel: string, resolved: string): boolean {
	return foldFile(rel) === foldFile(resolved);
}

/**
 * Counts describing exactly the nodes shipped in `roots`.
 *
 * `unresolved` and `unresolvedByReason` repeat the engine's own tree counters
 * deliberately rather than being copied from `tree.stats`: those are the two
 * numbers a caller checks against the nodes actually in front of them, and a
 * stat that describes a different set than the payload is worse than none.
 * They agree with the engine here — the handler ships the engine's roots
 * unchanged — and the walk was already visiting every node.
 *
 * Zero-count reasons are omitted, so the keys are exactly this tree's holes.
 * `spread-props` is never one of them: it marks an unknown test-id *value* on a
 * node whose children are all present, not a missing subtree.
 */
function subtreeStats(roots: UiNode[]): Record<string, unknown> {
	let nodes = 0;
	let testIds = 0;
	let patterns = 0;
	let dynamic = 0;
	let unresolved = 0;
	const byReason: Partial<Record<UiUnresolvedReason, number>> = {};
	const visit = (node: UiNode): void => {
		nodes += 1;
		if (node.testId) {
			testIds += 1;
			if (node.testId.kind === "pattern") {
				patterns += 1;
			} else if (node.testId.kind === "dynamic") {
				dynamic += 1;
			}
		}
		const reason = node.unresolved?.reason;
		if (reason && reason !== "spread-props") {
			unresolved += 1;
			byReason[reason] = (byReason[reason] ?? 0) + 1;
		}
		for (const child of node.children) {
			visit(child);
		}
	};
	for (const root of roots) {
		visit(root);
	}
	return {
		nodes,
		testIds,
		patterns,
		dynamic,
		unresolved,
		// An empty object would be noise on a complete tree; its absence and
		// `unresolved: 0` say the same thing once.
		...(unresolved > 0 ? { unresolvedByReason: byReason } : {}),
	};
}

interface TreeGap {
	kind: "not-followed" | "depth" | "nodes" | "boundary";
	detail: string;
	/** Set for `boundary`: the reason that accounts for most of the gap. */
	reason?: UiUnresolvedReason;
}

/**
 * Why the walk could not see the whole tree, or `null` when it saw all of it.
 *
 * Only cuts that *hide* nodes count: the depth limit and the node budget stop
 * the walk outright, a component left unexpanded hides whatever it renders, and
 * a `#unresolved` marker stands for content the walk saw but could not place.
 * `spread-props` is not one of them — that marks an unknown test id on a node
 * whose children were still walked. `expandedAt` is not one either: the subtree
 * it points at is in this same tree.
 *
 * **Chosen by weight, not by rank.** This used to return the first hit in a
 * fixed order, so a single depth-limited node decided the advice for a tree
 * whose real problem was something else. Measured on one production page: 49
 * depth-limited sites against 178 `external-module` boundaries, and the reader
 * was told to re-call with a larger depth — advice that addresses 17% of the
 * gap. Following it cost 37% more bytes and returned nothing, because no depth
 * reaches inside a module that was never scanned.
 *
 * `not-followed` still wins outright when present: it is the only reason the
 * caller *chose*, so the fix is one argument away and no count changes that.
 */
function traversalGap(roots: UiNode[], truncated: boolean): TreeGap | null {
	let notFollowed = 0;
	let depthCut = 0;
	const boundaries = new Map<UiUnresolvedReason, number>();
	const visit = (nodes: UiNode[]): void => {
		for (const node of nodes) {
			const reason = node.unresolved?.reason;
			if (reason === "not-followed") {
				notFollowed += 1;
			} else if (reason === "depth-limit-reached") {
				depthCut += 1;
			} else if (
				reason !== undefined &&
				reason !== "spread-props" &&
				(node.nodeType === "component" || node.nodeType === "unresolved")
			) {
				boundaries.set(reason, (boundaries.get(reason) ?? 0) + 1);
			}
			visit(node.children);
		}
	};
	visit(roots);

	if (notFollowed > 0) {
		return {
			kind: "not-followed",
			detail: `${notFollowed} component tag(s) were reported without expanding them`,
		};
	}

	// The widest boundary reason, and how it compares with the depth cuts.
	let topReason: UiUnresolvedReason | undefined;
	let topCount = 0;
	for (const [reason, count] of boundaries) {
		if (count > topCount) {
			topReason = reason;
			topCount = count;
		}
	}

	if (topReason && topCount >= depthCut && topCount > 0) {
		return {
			kind: "boundary",
			detail:
				topCount === 1
					? `a component in that tree was left unexpanded (${topReason})`
					: `${topCount} component(s) in that tree were left unexpanded (${topReason})`,
			reason: topReason,
		};
	}
	if (depthCut > 0) {
		return {
			kind: "depth",
			detail: `the depth limit cut the walk short at ${depthCut} site(s)`,
		};
	}
	if (truncated) {
		return { kind: "nodes", detail: "the node budget ran out mid-walk" };
	}
	return null;
}

/**
 * What to do about a gap: the next call, not an apology.
 *
 * `meta.fidelityReason` already counts the holes and names their codes, so this
 * says only the two things it cannot — which argument closes the gap, and that
 * an id's absence from a holed tree proves nothing.
 */
function gapHint(
	gap: TreeGap,
	depth: number,
	followComponents: boolean,
): string {
	const caveat =
		"An id missing from an incomplete tree may still be rendered; pass testId to look one up across the whole scan.";
	if (gap.kind === "not-followed") {
		return `Re-call with followComponents: true to see inside them. ${caveat}`;
	}
	if (gap.kind === "depth") {
		if (!followComponents) {
			return `Re-call with followComponents: true. ${caveat}`;
		}
		return depth >= 10
			? `Depth is already at the maximum. ${caveat}`
			: `Re-call with a larger depth (this call walked ${depth}, max 10). ${caveat}`;
	}
	if (gap.kind === "nodes") {
		return `The node budget ran out; re-call with file or component set to a narrower root. ${caveat}`;
	}
	// The commonest gap on a real application, and the one that used to get no
	// advice at all beyond the caveat — while a single depth-limited node
	// elsewhere in the tree hijacked the hint into recommending a bigger depth.
	// Each reason has a different answer and only one of them is a budget.
	switch (gap.reason) {
		case "external-module":
			return `Those components ship from outside the scanned sources, so no depth reaches inside them - re-root the server with --project-root covering their sources, or accept the gap. ${caveat}`;
		case "local-render-function":
			return `A same-file function returning JSX could not be inlined; its call is in the node's \`raw\`, so read that function directly. ${caveat}`;
		case "imported-render-function":
			return `A function imported from another file in this repository returns JSX and is called here; the call is in the node's \`raw\`. Its elements belong to that file, so root a tree there rather than expecting them inline. ${caveat}`;
		case "identifier-unresolved":
		case "namespaced-component":
		case "not-a-function-component":
			return `Those tags do not resolve to a function component the walk can enter. If one of them is a component in this repository, root a tree at it with \`component\`. ${caveat}`;
		case "recursive":
			return `The component renders itself and the walk cut the cycle; there is nothing to re-call with. ${caveat}`;
		default:
			return caveat;
	}
}

/** Bucket names in the order the report ships them. */
const BUCKET_ORDER: CoverageBucket[] = [...COVERAGE_BUCKETS];

/** Which lists this call asked for, and whether an argument was overruled. */
function selectedBuckets(
	requested: CoverageBucket[] | undefined,
	includeUnused: boolean,
	/** Whether the caller actually wrote `includeUnused`, rather than defaulting. */
	unusedWasGiven: boolean,
): { buckets: Set<CoverageBucket>; ignored?: string[] } {
	if (requested !== undefined) {
		// Two ways to say the same thing, so one of them has to win, and the
		// explicit list is the one the caller wrote on purpose. Saying which was
		// dropped costs one meta field and saves a debugging session.
		//
		// An empty array is a list too: `buckets: []` asks for summary and scope
		// and nothing else, which is the cheapest possible coverage call. Reading
		// it as "no preference" returned all six lists — the opposite of what the
		// schema promises, at the maximum response size.
		// Only when there was something to overrule. `includeUnused` became
		// optional, and reporting it as ignored on a call that never mentioned it
		// tells the caller an argument of theirs was dropped when none was.
		return {
			buckets: new Set(requested),
			...(unusedWasGiven ? { ignored: ["includeUnused"] } : {}),
		};
	}
	const buckets = new Set(BUCKET_ORDER);
	if (!includeUnused) {
		buckets.delete("uncoveredTestIds");
	}
	return { buckets };
}

/** One list this call means to return: its page, and the size it was cut from. */
interface BucketSlice {
	name: CoverageBucket;
	total: number;
	page: unknown[];
}

/** What actually shipped, once the byte budget has had its say. */
interface CoveragePaging {
	shown: Record<string, number>;
	nextOffset: Record<string, number>;
	/** Buckets the size cap cut below the page `limit` had already selected. */
	truncatedBuckets: CoverageBucket[];
	/** Entries remain past what shipped, whether cut by `limit` or by bytes. */
	truncated: boolean;
	/** Entries shipped across every returned bucket. */
	returned: number;
	/** The size cap cut something: `truncatedBuckets` is non-empty. */
	degraded: boolean;
	/**
	 * Buckets that kept no entry at all, so `nextOffset` cannot name them.
	 *
	 * Carried here rather than re-derived from `shown === 0`, which is how
	 * {@link degradeHint} used to find them. The reserve measurement builds the
	 * meta at its widest, and under that rule the two dimensions fight: the
	 * widest `shown` is the page length, which is never zero, so the starvation
	 * sentence was never in the reserve at all - and a page trimmed to the bytes
	 * it allowed came back `too_large` anyway, reproduced at 99 bytes over. As
	 * its own field it can be set to every bucket while the numbers beside it
	 * stay at full width.
	 */
	starved: CoverageBucket[];
}

/**
 * The coverage envelope, shrunk to fit rather than refused.
 *
 * An oversized report used to come back as a `too_large` error carrying advice.
 * That is the one answer an agent cannot use: it has spent a call, learned
 * nothing about the repository, and has to guess which knob to turn. So
 * `summary` and `scope` always ship — they are the totals every capped list is
 * read against — and each requested bucket ships as much of its page as the
 * remaining bytes allow, with `meta.truncatedBuckets` naming what was cut and
 * `meta.nextOffset` saying where to resume.
 *
 * Fitting is measured, never estimated, and never quadratic (see
 * {@link fitBuckets}). The reserve is measured first, with the meta at its
 * widest — every bucket named as truncated, every `nextOffset` at its largest
 * possible value, the longest hint — because `compactMeta` only ever removes
 * keys, so the real meta cannot exceed the one measured here.
 *
 * If even that reserve is over the cap, nothing is kept, `ok` refuses the
 * result, and the caller gets the genuine `too_large` with this tool's own
 * shrink advice. That case falls out of the arithmetic rather than needing its
 * own branch.
 */
function coverageResult(input: {
	base: Record<string, unknown>;
	slices: BucketSlice[];
	offset: number;
	buildMeta: (paging: CoveragePaging) => ToolMeta;
	shrinkHint: string;
	onDelivered?: () => void;
}): TextResult {
	const { base, slices, offset, buildMeta, shrinkHint, onDelivered } = input;

	const pagingFor = (kept: number[]): CoveragePaging => {
		const shown: Record<string, number> = {};
		const nextOffset: Record<string, number> = {};
		const truncatedBuckets: CoverageBucket[] = [];
		const starved: CoverageBucket[] = [];
		let truncated = false;
		let returned = 0;
		slices.forEach((slice, index) => {
			const count = kept[index];
			const end = offset + count;
			returned += count;
			if (end < slice.total) {
				truncated = true;
				// Only when it is forward progress. A bucket whose first entry does
				// not fit keeps `end === offset`, and echoing that back as the next
				// page is an invitation to loop on the same call forever; the hint
				// says what to do instead.
				if (end > offset) {
					nextOffset[slice.name] = end;
				}
			}
			// Only when the page is not the whole bucket: on a complete list the
			// count is the array's own length and saying it again is noise.
			if (count !== slice.total) {
				shown[slice.name] = count;
			}
			if (count < slice.page.length) {
				truncatedBuckets.push(slice.name);
			}
			if (count === 0 && slice.page.length > 0) {
				starved.push(slice.name);
			}
		});
		return {
			shown,
			nextOffset,
			truncatedBuckets,
			truncated,
			returned,
			degraded: truncatedBuckets.length > 0,
			starved,
		};
	};

	const dataFor = (kept: number[]): Record<string, unknown> => {
		const data: Record<string, unknown> = { ...base };
		slices.forEach((slice, index) => {
			data[slice.name] =
				kept[index] === slice.page.length
					? slice.page
					: slice.page.slice(0, kept[index]);
		});
		return data;
	};

	// The ordinary answer, measured once. Everything that already fits takes this
	// path and is byte-identical to what it was before auto-degrade existed.
	const whole = slices.map((slice) => slice.page.length);
	const wholeData = dataFor(whole);
	const wholeMeta = buildMeta(pagingFor(whole));
	if (envelopeBytes(wholeData, wholeMeta) <= MAX_RESPONSE_BYTES) {
		return ok(wholeData, wholeMeta, { shrinkHint, onDelivered });
	}

	const widestMeta = buildMeta({
		shown: Object.fromEntries(
			slices.map((slice) => [slice.name, slice.page.length]),
		),
		nextOffset: Object.fromEntries(
			slices.map((slice) => [slice.name, offset + slice.page.length]),
		),
		truncatedBuckets: slices.map((slice) => slice.name),
		truncated: true,
		returned: 0,
		degraded: true,
		// Every bucket, so the starvation sentence is measured at full length.
		starved: slices
			.filter((slice) => slice.page.length > 0)
			.map((slice) => slice.name),
	});
	const reserve = envelopeBytes(dataFor(slices.map(() => 0)), widestMeta);
	const fit = fitBuckets(
		MAX_RESPONSE_BYTES - reserve,
		slices.map((slice) => ({ name: slice.name, entries: slice.page })),
	);
	const kept = slices.map((slice) => fit.get(slice.name) ?? 0);
	return ok(dataFor(kept), buildMeta(pagingFor(kept)), {
		shrinkHint,
		onDelivered,
	});
}

/**
 * What to say when the size cap cut the page down.
 *
 * Names the lists that lost entries and the exact next call, because the value
 * of degrading over erroring is only realised if the caller knows how to
 * continue. A bucket that lost *everything* is the one case `nextOffset` cannot
 * express, so it gets its own sentence.
 */
function degradeHint(
	paging: CoveragePaging,
	coverageId: string | undefined,
): string | undefined {
	if (!paging.degraded) {
		return undefined;
	}
	const starved = paging.starved;
	const cut = paging.truncatedBuckets;
	// The worked example resumes a bucket that actually has a next page; a
	// starved one has no offset to name and gets its own sentence instead.
	const resumable = cut.find((name) => paging.nextOffset[name] !== undefined);
	const resume =
		coverageId && resumable
			? `query_coverage {"coverageId":"${coverageId}","bucket":"${resumable}","offset":${paging.nextOffset[resumable]}}`
			: "a lower `limit`, then `offset`";
	const starvation =
		starved.length > 0
			? ` ${starved.join(", ")} held no entry small enough for the bytes left over; request that bucket on its own so it gets the whole budget.`
			: "";
	return `This page would have exceeded the ${MAX_RESPONSE_BYTES}-byte response cap, so ${cut.join(", ")} ${cut.length > 1 ? "were" : "was"} cut to fit instead of the call failing - summary still reports every bucket's real size. Continue with ${resume}.${starvation}`;
}

export function handleMapCoverage(
	workspace: Workspace,
	args: z.infer<typeof mapCoverageInput>,
	options: Pick<McpServerOptions, "assumeForwarded"> &
		ToolSession & {
			handles?: CoverageHandles;
		} = {},
) {
	let poInclude: string[] | undefined;
	let alsoIncluded: string[] | undefined;
	let note: string | undefined;
	if (args.file) {
		// Scoping is a path glob, so an unmatched `file` selects zero page objects
		// and the report comes back "successful" with every rendered id uncovered —
		// which reads as a suite that tests nothing and invites edits to page
		// objects that were never in scope. Resolve it against the index first, the
		// way the `class` branch does. Controls count: they are only left out of
		// `list_page_objects`, not out of the coverage scan.
		//
		// The plain index is consulted first because it is the one every other
		// handler already built. Widening to controls is a *second* full discovery
		// under a different memo key — measured at 770 ms on a 4,924-file
		// repository — and only a file that declares nothing but controls needs it.
		// The answer is the same either way: the controls index is a superset, so a
		// file found in the plain one is found in both, and a file in neither
		// produces the same error from the same widened candidate list.
		const resolved = relativizeFile(workspace, args.file);
		note = resolved.note;
		const wanted = foldFile(resolved.file);
		const filesOf = (includeControls: boolean): string[] => [
			...new Set(
				discoverPageObjects(workspace, { includeControls }).pageObjects.map(
					(item) => item.file,
				),
			),
		];
		let files = filesOf(false);
		let match = files.find((file) => foldFile(file) === wanted);
		if (!match) {
			files = filesOf(true);
			match = files.find((file) => foldFile(file) === wanted);
		}
		if (!match) {
			const suggestions = nearestFiles(resolved.file, files);
			throw new ToolError(
				"file_not_found",
				`No page object is declared in "${args.file}".`,
				{
					suggestions,
					hint: hintForSuggestions(suggestions, {
						some: "Use one of the suggested paths, or pass `class` and let the server find the file; list_page_objects reports the file of every page object.",
						none: "No page-object file resembles that path - it may be a UI source rather than a page object, and this tool scopes by page object. Pass `class`, or call list_page_objects to see every page object and its file.",
					}),
				},
			);
		}
		// The discovered spelling, not the caller's: the include glob is matched
		// case-sensitively against workspace-relative paths.
		poInclude = [match];
	} else if (args.class) {
		const index = discoverPageObjects(workspace);
		const matches = index.pageObjects.filter(
			(item) => item.className === args.class,
		);
		if (matches.length === 0) {
			const wanted = args.class ?? "";
			const names = index.pageObjects.map((item) => item.className);
			// Substring then edit distance, in `nearestNames`: the two passes used
			// to be spelled out here and nowhere else, which is how the engine's own
			// class lookup ended up with only one of them.
			const suggestions = nearestNames(wanted, names, MAX_ERROR_LIST);
			throw new ToolError(
				"class_not_found",
				`No page object named "${wanted}" was found.`,
				{
					suggestions,
					hint: "Call list_page_objects to see every page object.",
				},
			);
		}
		if (matches.length > 1) {
			throw new ToolError(
				"ambiguous_class",
				`${matches.length} classes named "${args.class}".`,
				{
					candidates: matches.map((item) => item.file),
					hint: "Re-call with `file` set to one of the candidates.",
				},
			);
		}
		poInclude = [matches[0].file];
		// Scoping happens by path, so page objects sharing the file are analyzed
		// too and do count towards the totals. Say so rather than imply otherwise.
		const shared = index.pageObjects
			.filter(
				(item) =>
					item.file === matches[0].file &&
					item.className !== matches[0].className,
			)
			.map((item) => item.className);
		if (shared.length > 0) {
			alsoIncluded = shared;
		}
	}

	const report = buildCoverageReport(workspace, {
		attribute: args.attribute,
		poInclude,
		includeRawLocators: args.includeRawLocators,
		assumeForwarded: options.assumeForwarded,
	});

	// A scoped call narrows the selectors and cannot narrow the ids they are
	// compared against, so `uncoveredTestIds` is still every id in the
	// application - measured at 61,788 bytes on a real app, to answer a question
	// about one class. The report says so in a warning, but the caller pays the
	// whole list to read it. So the list is off by default exactly when it is
	// least likely to be what was meant, and the caller can still ask.
	const scoped = poInclude !== undefined;
	const includeUnused = args.includeUnused ?? !scoped;
	const { buckets, ignored } = selectedBuckets(
		args.buckets as CoverageBucket[] | undefined,
		includeUnused,
		args.includeUnused !== undefined,
	);
	const unusedDefaultedOff =
		scoped && args.includeUnused === undefined && args.buckets === undefined;
	// One `offset` across every returned bucket, rather than one per bucket: the
	// way an agent actually pages is to ask for a single bucket and walk it
	// (`query_coverage`, or `buckets:["unknownTestIds"]`), and a map of offsets
	// keyed by bucket is a second thing to get wrong for a case nobody drives.
	// The totals are in `summary` for all six buckets whatever this call
	// returned, so `meta` only has to say what is missing from *here*: how many
	// came back, and where the next page starts.
	const offset = args.offset;
	const slices: BucketSlice[] = [];
	let largest = 0;
	for (const bucket of BUCKET_ORDER) {
		if (!buckets.has(bucket)) {
			continue;
		}
		const list: unknown[] = report[bucket];
		largest = Math.max(largest, list.length);
		slices.push({
			name: bucket,
			total: list.length,
			page: list.slice(offset, offset + args.limit),
		});
	}

	const attributeSource = args.attribute
		? "param"
		: workspace.testIdAttribute().source;
	// Minted on every call, including `buckets: []` — summary-first then page the
	// one bucket that matters is the workflow this is for, and the summary-only
	// call is where that walk starts.
	const coverageId = options.handles?.create(workspace, {
		report,
		attributeSource,
		assumeForwarded: options.assumeForwarded === true ? true : undefined,
		alsoIncluded,
		note,
	});

	// Once, not inside `buildMeta`: that runs up to three times while the payload
	// is measured against the cap, and a plan that abbreviated more on each pass
	// would make the measured size disagree with the sent one.
	const warnings = planWarnings(options.warnings, report.warnings);

	return coverageResult({
		// `summary` and `scope` always ship: they are the totals every capped list
		// is read against, and a bucket selection that hid them would turn a
		// shorter response into an unreadable one.
		base: { summary: report.summary, scope: report.scope },
		slices,
		offset,
		onDelivered: warnings.delivered,
		shrinkHint: coverageShrinkHint(
			args.buckets as CoverageBucket[] | undefined,
			args.limit,
			coverageId,
		),
		buildMeta: (paging) => ({
			attribute: report.attribute,
			attributeSource,
			playwrightConfig: configFileOf(workspace),
			// In `meta`, next to `offset` / `shown` / `nextOffset`: the handle is a
			// paging cursor, and every other paging field already lives here. An
			// agent reading `meta.nextOffset` needs the id it belongs to in the same
			// place, not one level away in the report body.
			coverageId,
			alsoIncluded,
			note,
			assumeForwarded: options.assumeForwarded === true ? true : undefined,
			ignored,
			offset: offset > 0 ? offset : undefined,
			shown: Object.keys(paging.shown).length > 0 ? paging.shown : undefined,
			nextOffset:
				Object.keys(paging.nextOffset).length > 0
					? paging.nextOffset
					: undefined,
			truncatedBuckets: paging.truncatedBuckets,
			warnings: warnings.shown,
			truncated: paging.truncated,
			// A coverage score computed against the wrong attribute used to read as
			// a healthy `1` (zero of zero ids covered) — the one number in this
			// payload nobody double-checks. It gets the loudest treatment.
			hint: withEnvironmentHint(
				report.warnings,
				degradeHint(paging, coverageId) ??
					pagingHint(offset, slices.length, paging.returned, largest) ??
					(unusedDefaultedOff
						? `uncoveredTestIds was left out: this call is scoped to a page object, and that list is project-wide whatever the scope, so it would mostly be ids other page objects cover (summary.uncoveredTestIds still counts them). Ask for it with buckets:["uncoveredTestIds"] or includeUnused:true.`
						: undefined),
			),
		}),
	});
}

/**
 * Pages one bucket of a report a previous `map_coverage` call already built.
 *
 * The handle is what makes the walk checkable. `map_coverage` with
 * `{buckets:["x"], offset:N}` returns the same entries just as cheaply — the
 * report is memoized per epoch — but it re-derives the report each time, so an
 * edit between two pages silently renumbers the list underneath the offsets and
 * the response says nothing. Here the same edit invalidates the handle and the
 * caller is told, which is the difference between a paging walk that can be
 * trusted and one that merely usually works.
 */
export function handleQueryCoverage(
	workspace: Workspace,
	args: z.infer<typeof queryCoverageInput>,
	handles: CoverageHandles,
	session: ToolSession = {},
) {
	const lookup = handles.resolve(args.coverageId, workspace);
	if (!lookup.ok) {
		throw new ToolError("expired_handle", handleFailureMessage(lookup.reason), {
			hint: `Re-call map_coverage with the arguments that produced this id (its scope is not recoverable from the id itself) and use the new meta.coverageId. ${HANDLE_LIFETIME_TEXT}`,
		});
	}
	const { report, attributeSource, assumeForwarded, alsoIncluded, note } =
		lookup.snapshot;

	const list: unknown[] = report[args.bucket];
	const slice: BucketSlice = {
		name: args.bucket,
		total: list.length,
		page: list.slice(args.offset, args.offset + args.limit),
	};

	const warnings = planWarnings(session.warnings, report.warnings);

	return coverageResult({
		// `summary` on every page is deliberate - it is what a capped list is read
		// against. `scope` is not: it is byte-identical on every page of the same
		// snapshot, and the handle guarantees the snapshot has not moved, so past
		// the first page it is ~2 KB of prose the reader already has from the call
		// that minted the id. The tool description says where to find it.
		base:
			args.offset > 0
				? { summary: report.summary }
				: { summary: report.summary, scope: report.scope },
		slices: [slice],
		offset: args.offset,
		onDelivered: warnings.delivered,
		shrinkHint: `Re-call with a lower \`limit\` (this call used ${args.limit}), then page the rest with \`offset\`. map_coverage with buckets: [] returns the totals alone.`,
		buildMeta: (paging) => ({
			attribute: report.attribute,
			attributeSource,
			playwrightConfig: configFileOf(workspace),
			// Echoed so a page is a complete instruction for the next one: the id
			// stays valid for as long as the sources do not change.
			coverageId: args.coverageId,
			bucket: args.bucket,
			alsoIncluded,
			note,
			assumeForwarded,
			offset: args.offset > 0 ? args.offset : undefined,
			// One bucket, so one number rather than the record `map_coverage`
			// returns: `meta.nextOffset` copies straight into the next call's
			// `offset`, which is what makes the walk hard to get wrong.
			shown: paging.shown[args.bucket],
			nextOffset: paging.nextOffset[args.bucket],
			truncatedBuckets: paging.truncatedBuckets,
			warnings: warnings.shown,
			truncated: paging.truncated,
			hint: withEnvironmentHint(
				report.warnings,
				degradeHint(paging, args.coverageId) ??
					pagingHint(args.offset, 1, paging.returned, list.length),
			),
		}),
	});
}

/**
 * What to change to make THIS coverage call fit.
 *
 * The generic advice named `includeUnused`, which `selectedBuckets` ignores
 * whenever `buckets` is set. A caller who had already narrowed to one bucket
 * was told to pass a no-op, re-called, and got a byte-identical error - the
 * one shape of hint that costs a call and teaches nothing. So the advice now
 * depends on which knobs are still live.
 */
export function coverageShrinkHint(
	buckets: CoverageBucket[] | undefined,
	limit: number,
	coverageId?: string,
): string {
	const lowerLimit = `a lower \`limit\` (this call used ${limit})`;
	// Only reachable when even `summary` + `scope` overflow, since a bucket page
	// is now trimmed to fit rather than refused - but that is exactly the call
	// where naming a handle nobody can spend would be noise.
	const handle = coverageId
		? ` Or page one bucket at a time with query_coverage {"coverageId":"${coverageId}", ...}.`
		: "";

	if (buckets === undefined) {
		return `Re-call with ${lowerLimit}, \`buckets\` naming only the lists you need, or includeUnused:false. \`buckets: []\` returns summary and scope alone, which always fits.${handle}`;
	}
	if (buckets.length > 1) {
		return `Re-call with ${lowerLimit}, or fewer \`buckets\` - one at a time pages cleanly through \`offset\`. (\`includeUnused\` is ignored while \`buckets\` is set.)${handle}`;
	}
	// One bucket already, so the only lever left is the page size. Naming
	// `buckets` again here is what produced the loop.
	return `Re-call with ${lowerLimit}, then page the rest with \`offset\`. \`buckets: []\` returns summary and scope alone if you only need the totals.${handle}`;
}

/**
 * What to say about an empty page.
 *
 * An offset past the end returns `[]` for every bucket, which reads exactly
 * like "there is nothing here" — the same confusion `list_page_objects` had,
 * and the reason it reports the end of its list rather than an empty one.
 */
function pagingHint(
	offset: number,
	requested: number,
	returned: number,
	largest: number,
): string | undefined {
	if (offset === 0 || requested === 0 || returned > 0) {
		return undefined;
	}
	return largest === 0
		? `Every requested bucket is empty, so offset ${offset} returned nothing; the buckets themselves hold no entries.`
		: `offset ${offset} is past the end of every requested bucket (the largest holds ${largest}); re-call with a smaller offset.`;
}
