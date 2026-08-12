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
	nearestNames,
	normalizeRelPath,
	type PageObjectSummary,
	type SelectorInfo,
	scannedComponents,
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
	BUCKET_ORDER,
	type BucketSlice,
	coverageResult,
	coverageShrinkHint,
	degradeHint,
	pagingHint,
	selectedBuckets,
} from "./present/coverage";
import {
	blindScan,
	gapHint,
	idsNotPlaced,
	subtreeStats,
	traversalGap,
} from "./present/gaps";
import { listEmptyHint, lookupHint, missingComponent } from "./present/hints";
import { foldFile, isScannedFile } from "./present/paths";
import { MAX_ERROR_LIST, ok } from "./respond";
import type {
	getPageObjectTreeInput,
	getTestIdTreeInput,
	listPageObjectsInput,
	mapCoverageInput,
	queryCoverageInput,
} from "./schemas";
import { planWarnings, type WarningLedger } from "./warnings";

/**
 * The per-server state a tool call may consult.
 *
 * Optional throughout, so a handler called without one behaves exactly as it
 * did before sessions existed - which is what makes the handlers callable
 * directly, with a `Workspace` and nothing else, rather than only through a
 * booted server.
 *
 * That is a property of the signature, not a claim about the suite: every test
 * today goes through a client, so the direct path is available and unused.
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

/**
 * What to say when a tool found nothing, or found the wrong thing.
 *
 * An empty answer is the one an agent is most likely to act on wrongly - it
 * reads as "there is nothing here" when it usually means "you asked the wrong
 * question" - so each of these turns a count into the next call to make.
 *
 * Pure over the engine's summaries and plain counts, and therefore testable as
 * a table rather than through a repository built to produce a zero.
 */

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
