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
	type UiNode,
	type UiUnresolvedReason,
	type Workspace,
} from "../analysis";
import { ToolError } from "./errors";
import type { McpServerOptions } from "./options";
import { renderPageObjectOutline, renderTestIdOutline } from "./outline";
import { MAX_ERROR_LIST, ok } from "./respond";
import {
	COVERAGE_BUCKETS,
	type getPageObjectTreeInput,
	type getTestIdTreeInput,
	type listPageObjectsInput,
	type mapCoverageInput,
} from "./schemas";

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

	return undefined;
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
			warnings: index.warnings,
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

	if (!args.includeMethods) {
		for (const def of Object.values(tree.defs)) {
			def.methods = [];
		}
	}

	const meta = {
		root: tree.projectRoot,
		attribute: tree.testIdAttribute,
		attributeSource: tree.testIdAttributeSource,
		playwrightConfig: configFileOf(workspace),
		note: resolved.note,
		truncated: tree.truncated,
		warnings: tree.warnings,
		hint: environmentHint(tree.warnings),
	};

	const shrink = {
		shrinkHint: `Re-call with format:"outline", a lower depth (this call used ${args.depth}), or includeMethods:false.`,
	};

	if (args.format === "outline") {
		return ok(renderPageObjectOutline(tree), meta, shrink);
	}

	return ok(
		{ root: tree.root, defs: tree.defs, stats: tree.stats },
		meta,
		shrink,
	);
}

/** What a `testId` lookup should say beyond the occurrence list itself. */
function lookupHint(
	needle: string,
	found: number,
	catchAllSkipped: number,
	propOnly: boolean,
): string | undefined {
	if (found === 0) {
		const quarantined =
			catchAllSkipped > 0
				? ` ${catchAllSkipped} element(s) do write the attribute with a value built entirely at runtime, which would match any id and so proves nothing about this one; they are excluded.`
				: "";
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
		throw new ToolError(
			"file_not_found",
			`No scanned .tsx/.jsx source matches "${file}".`,
			{
				suggestions: nearestFiles(resolved.file, candidates),
				hint: "Use one of the suggested paths, or pass `component` and let the server find the file. Only scanned .tsx/.jsx sources can root a tree: if the file is on disk but outside the scan, restart the server with --src-dir <dir> (or --project-root <dir>) covering it.",
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
		return new ToolError(
			"file_not_found",
			`No component named "${wanted}" was found in the scanned sources.`,
			{
				suggestions: nearestNames(
					wanted,
					all.map((component) => component.name),
					MAX_ERROR_LIST,
				),
				hint: "Pass one of the suggested names, pass `file` with the component's path, or omit both to auto-detect the app entry.",
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
			hint:
				inFile.length === 0
					? "Pass `file` with the path of a file that declares a component, or omit both to auto-detect the app entry."
					: "Pass one of the suggested names, drop `file` to search every scanned file, or omit both to auto-detect the app entry.",
		},
	);
}

export function handleGetTestIdTree(
	workspace: Workspace,
	args: z.infer<typeof getTestIdTreeInput>,
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
		return ok(
			{ occurrences },
			{
				attribute: tree.attribute,
				attributeSource: tree.attributeSource,
				playwrightConfig: configFileOf(workspace),
				// "That id is not rendered anywhere" is the single most misleading
				// answer this server can give when the attribute or the scope is
				// wrong, and this branch used to ship it with no warnings at all.
				warnings: tree.warnings,
				hint: withEnvironmentHint(
					tree.warnings,
					lookupHint(needle, occurrences.length, catchAllSkipped, propOnly),
				),
			},
			{
				shrinkHint:
					'Re-call with format:"outline", a lower depth, or scope the walk with `file` or `component`.',
			},
		);
	}

	let entry = scope?.file;
	let entryComponent: string | undefined;
	let requested: ComponentInfo | undefined;
	let siblings: ComponentInfo[] = [];
	const scopeFile = scope?.file;
	if (args.component) {
		const probe = buildTestIdTree(workspace, {
			attribute: args.attribute,
			maxDepth: 1,
			followComponents: false,
		});
		const components = Object.values(probe.components);
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
	const meta: Record<string, unknown> = {
		attribute: tree.attribute,
		attributeSource: tree.attributeSource,
		playwrightConfig: configFileOf(workspace),
		note: scope?.note,
		fidelity: tree.fidelity,
		fidelityReason: tree.fidelityReason,
		truncated: tree.truncated,
		scanned: tree.stats.files,
		warnings: tree.warnings,
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
	};

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
 * `not-followed` is ranked first because it is the only one the caller asked
 * for, so it is the only one where the fix is a different argument rather than
 * a bigger budget.
 */
function traversalGap(roots: UiNode[], truncated: boolean): TreeGap | null {
	let notFollowed = 0;
	let depthCut = false;
	let boundary: string | undefined;
	const visit = (nodes: UiNode[]): void => {
		for (const node of nodes) {
			const reason = node.unresolved?.reason;
			if (reason === "not-followed") {
				notFollowed += 1;
			} else if (reason === "depth-limit-reached") {
				depthCut = true;
			} else if (
				reason !== undefined &&
				reason !== "spread-props" &&
				(node.nodeType === "component" || node.nodeType === "unresolved")
			) {
				boundary ??= reason;
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
	if (depthCut) {
		return { kind: "depth", detail: "the depth limit cut the walk short" };
	}
	if (truncated) {
		return { kind: "nodes", detail: "the node budget ran out mid-walk" };
	}
	if (boundary) {
		return {
			kind: "boundary",
			detail: `a component in that tree was left unexpanded (${boundary})`,
		};
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
	return caveat;
}

/** Bucket names in the order the report ships them. */
const BUCKET_ORDER: CoverageBucket[] = [...COVERAGE_BUCKETS];

/** Which lists this call asked for, and whether an argument was overruled. */
function selectedBuckets(
	requested: CoverageBucket[] | undefined,
	includeUnused: boolean,
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
		return { buckets: new Set(requested), ignored: ["includeUnused"] };
	}
	const buckets = new Set(BUCKET_ORDER);
	if (!includeUnused) {
		buckets.delete("uncoveredTestIds");
	}
	return { buckets };
}

export function handleMapCoverage(
	workspace: Workspace,
	args: z.infer<typeof mapCoverageInput>,
	options: Pick<McpServerOptions, "assumeForwarded"> = {},
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
		const index = discoverPageObjects(workspace, { includeControls: true });
		const files = [...new Set(index.pageObjects.map((item) => item.file))];
		const resolved = relativizeFile(workspace, args.file);
		note = resolved.note;
		const wanted = foldFile(resolved.file);
		const match = files.find((file) => foldFile(file) === wanted);
		if (!match) {
			throw new ToolError(
				"file_not_found",
				`No page object is declared in "${args.file}".`,
				{
					suggestions: nearestFiles(resolved.file, files),
					hint: "Use one of the suggested paths, or pass `class` and let the server find the file; list_page_objects reports the file of every page object.",
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

	const { buckets, ignored } = selectedBuckets(
		args.buckets as CoverageBucket[] | undefined,
		args.includeUnused,
	);
	// `summary` and `scope` always ship: they are the totals every capped list is
	// read against, and a bucket selection that hid them would turn a shorter
	// response into an unreadable one.
	const data: Record<string, unknown> = {
		summary: report.summary,
		scope: report.scope,
	};
	// One `offset` across every returned bucket, rather than one per bucket: the
	// way an agent actually pages is to ask for a single bucket and walk it
	// (`buckets:["unknownTestIds"]`), and a map of offsets keyed by bucket is a
	// second thing to get wrong for a case nobody drives. The totals are in
	// `summary` for all six buckets whatever this call returned, so `meta` only
	// has to say what is missing from *here*: how many came back, and where the
	// next page starts.
	const offset = args.offset;
	const shown: Record<string, number> = {};
	const nextOffset: Record<string, number> = {};
	let truncated = false;
	let requested = 0;
	let returned = 0;
	let largest = 0;
	for (const bucket of BUCKET_ORDER) {
		if (!buckets.has(bucket)) {
			continue;
		}
		const list: unknown[] = report[bucket];
		const page = list.slice(offset, offset + args.limit);
		data[bucket] = page;
		requested += 1;
		returned += page.length;
		largest = Math.max(largest, list.length);
		const end = offset + page.length;
		if (end < list.length) {
			truncated = true;
			nextOffset[bucket] = end;
		}
		// Only when the page is not the whole bucket: on a complete list the count
		// is the array's own length and saying it again is noise.
		if (page.length !== list.length) {
			shown[bucket] = page.length;
		}
	}

	return ok(
		data,
		{
			attribute: report.attribute,
			attributeSource: args.attribute
				? "param"
				: workspace.testIdAttribute().source,
			playwrightConfig: configFileOf(workspace),
			alsoIncluded,
			note,
			assumeForwarded: options.assumeForwarded === true ? true : undefined,
			ignored,
			offset: offset > 0 ? offset : undefined,
			shown: Object.keys(shown).length > 0 ? shown : undefined,
			nextOffset: Object.keys(nextOffset).length > 0 ? nextOffset : undefined,
			warnings: report.warnings,
			truncated,
			// A coverage score computed against the wrong attribute used to read as
			// a healthy `1` (zero of zero ids covered) — the one number in this
			// payload nobody double-checks. It gets the loudest treatment.
			hint: withEnvironmentHint(
				report.warnings,
				pagingHint(offset, requested, returned, largest),
			),
		},
		{
			shrinkHint:
				"Re-call with a lower `limit`, fewer `buckets`, or includeUnused:false.",
		},
	);
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
