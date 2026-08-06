import type * as z from "zod";
import {
	buildCoverageReport,
	buildPageObjectTree,
	buildTestIdTree,
	type ComponentInfo,
	type Diagnostic,
	discoverPageObjects,
	nearestIds,
	normalizeRelPath,
	type PageObjectSummary,
	type SelectorInfo,
	type UiNode,
	type Workspace,
} from "../analysis";
import { ToolError } from "./errors";
import { renderPageObjectOutline, renderTestIdOutline } from "./outline";
import { ok } from "./respond";
import type {
	getPageObjectTreeInput,
	getTestIdTreeInput,
	listPageObjectsInput,
	mapCoverageInput,
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
	const shown = items.slice(0, args.limit);

	return ok(shown.map(summaryEntry), {
		root: index.projectRoot,
		attribute: index.testIdAttribute,
		attributeSource: index.testIdAttributeSource,
		playwrightConfig: configFileOf(workspace),
		scanned: index.stats.filesScanned,
		total: total > shown.length ? total : undefined,
		warnings: index.warnings,
		hint: withEnvironmentHint(
			index.warnings,
			total === 0
				? 'No classes with playwright-page-object decorators were found. If your page objects live elsewhere, restart the server with --src-dir <dir>; also check that those files import from "playwright-page-object".'
				: undefined,
		),
	});
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

	const target =
		args.class && args.file
			? `${args.file}#${args.class}`
			: (args.class ?? args.file ?? "");

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
		truncated: tree.truncated,
		warnings: tree.warnings,
		hint: environmentHint(tree.warnings),
	};

	if (args.format === "outline") {
		return ok(renderPageObjectOutline(tree), meta);
	}

	return ok({ root: tree.root, defs: tree.defs, stats: tree.stats }, meta);
}

export function handleGetTestIdTree(
	workspace: Workspace,
	args: z.infer<typeof getTestIdTreeInput>,
) {
	const depth = args.followComponents ? args.depth : 1;

	if (args.testId) {
		const tree = buildTestIdTree(workspace, {
			attribute: args.attribute,
			maxDepth: depth,
		});
		const needle = args.testId;
		const occurrences = tree.inventory.filter((occurrence) => {
			if (occurrence.value.kind === "static") {
				return occurrence.value.value === needle;
			}
			if (occurrence.value.kind === "pattern" && occurrence.value.regex) {
				return new RegExp(
					occurrence.value.regex.source,
					occurrence.value.regex.flags,
				).test(needle);
			}
			return false;
		});
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
					occurrences.length === 0
						? `No rendered element with test id "${needle}" was found. Call get_testid_tree without testId to see the full tree, or map_coverage to check for renamed ids.`
						: undefined,
				),
			},
		);
	}

	let entry = args.file;
	let requested: ComponentInfo | undefined;
	let siblings: ComponentInfo[] = [];
	const scopeFile = args.file;
	if (args.component) {
		const probe = buildTestIdTree(workspace, {
			attribute: args.attribute,
			maxDepth: 1,
		});
		const components = Object.values(probe.components);
		const named = components.filter(
			(component) => component.name === args.component,
		);
		// A component name is only unique per file. Narrow by `file` when the
		// caller gave one; otherwise a name two files declare is ambiguous, and
		// answering with whichever was scanned first is a guess.
		const matches = scopeFile
			? named.filter((component) => sameFile(component.file, scopeFile))
			: named;
		if (matches.length === 0) {
			throw new ToolError(
				"file_not_found",
				scopeFile
					? `No component named "${args.component}" is declared in "${scopeFile}".`
					: `No component named "${args.component}" was found in the scanned sources.`,
				{
					hint: scopeFile
						? "Drop `file` to search every scanned file, or omit both to auto-detect the app entry."
						: "Pass `file` with the component's path instead, or omit both to auto-detect the app entry.",
				},
			);
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
		requested = match;
		siblings = components.filter(
			(component) =>
				component.file === match.file && component.name !== match.name,
		);
	}

	const tree = buildTestIdTree(workspace, {
		attribute: args.attribute,
		entry,
		maxDepth: depth,
	});

	const meta: Record<string, unknown> = {
		attribute: tree.attribute,
		attributeSource: tree.attributeSource,
		playwrightConfig: configFileOf(workspace),
		fidelity: tree.fidelity,
		fidelityReason: tree.fidelityReason,
		truncated: tree.truncated,
		scanned: tree.stats.files,
		warnings: tree.warnings,
		hint: environmentHint(tree.warnings),
	};

	// The engine roots a file at its first (or default-exported) component, so a
	// file declaring several can answer with a component nobody asked for. Never
	// hand that back as if it were the requested one.
	let roots = tree.roots;
	if (requested && siblings.length > 0 && tree.fidelity === "full") {
		const actual = roots[0]?.component;
		if (actual === undefined) {
			meta.hint = withEnvironmentHint(
				tree.warnings,
				`The tree is empty and "${requested.file}" declares ${siblings.length + 1} components; a file is rooted at its first component, so this may not be "${requested.name}".`,
			);
		} else if (actual !== requested.name) {
			const subtree = findComponentNode(roots, requested.id);
			if (!subtree) {
				// "Not rendered" is only true of a tree the walk saw in full. A walk
				// cut short by depth, by the node budget or by an unexpanded child
				// proves nothing about the component it never reached — say that
				// instead of blaming the caller for asking.
				const gap = traversalGap(roots, tree.truncated === true);
				if (gap) {
					throw new ToolError(
						"incomplete_tree",
						`"${requested.name}" was not reached under "${actual}", but ${gap.detail}, so whether it renders there is unknown.`,
						{
							hint: gapHint(gap, requested.name, depth, args.followComponents),
						},
					);
				}
				throw new ToolError(
					"ambiguous_component",
					`"${requested.file}" declares ${siblings.length + 1} components; it is rooted at "${actual}", and "${requested.name}" is not rendered inside it.`,
					{
						candidates: [
							...new Set([actual, ...siblings.map((one) => one.name)]),
						].sort(),
						hint: `Request component "${actual}", or pass testId to find where "${requested.name}" is rendered.`,
					},
				);
			}
			roots = [subtree];
			meta.rootedAt = `${requested.name}, as rendered inside ${actual}`;
		}
	}

	if (args.format === "outline") {
		return ok(renderTestIdOutline({ ...tree, roots }), meta);
	}

	if (tree.fidelity === "flat") {
		return ok({ fidelity: "flat", inventory: tree.inventory }, meta);
	}

	// Counted over `roots`, not over the scan: after a re-root those are two
	// different shapes, and stats that describe something the caller cannot see
	// are worse than no stats. Scan-wide numbers live in `meta.scanned`.
	return ok({ fidelity: "full", roots, stats: subtreeStats(roots) }, meta);
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
 * Mirrors how the engine resolves an `entry` file: posix separators, a trailing
 * path segment is enough ("Nested.tsx" matches "src/Nested.tsx"), and case is
 * folded only where the filesystem folds it too.
 */
function sameFile(rel: string, wanted: string): boolean {
	const left = foldFile(rel);
	const right = foldFile(wanted);
	return left === right || left.endsWith(`/${right}`);
}

/**
 * Files worth naming after an unmatched path: the ones it is a trailing segment
 * of first (a caller who wrote "Home.ts" meant one of those), then plausible
 * typos, then whatever is left — an agent that gets an empty list has nothing to
 * retry with.
 */
function nearbyFiles(wanted: string, files: string[]): string[] {
	const folded = foldFile(wanted);
	const base = folded.slice(folded.lastIndexOf("/") + 1);
	const suffixed = files.filter((file) => {
		const candidate = foldFile(file);
		return (
			candidate.endsWith(`/${folded}`) ||
			candidate.slice(candidate.lastIndexOf("/") + 1) === base
		);
	});
	return [
		...new Set([
			...suffixed,
			...nearestIds(normalizeRelPath(wanted), files, 5),
			...[...files].sort(),
		]),
	].slice(0, 5);
}

/** First node in document order whose expansion is `componentId`. */
function findComponentNode(
	nodes: UiNode[],
	componentId: string,
): UiNode | null {
	for (const node of nodes) {
		if (node.componentRef === componentId) {
			return node;
		}
		const found = findComponentNode(node.children, componentId);
		if (found) {
			return found;
		}
	}
	return null;
}

/** Counts describing exactly the nodes shipped in `roots`. */
function subtreeStats(roots: UiNode[]): Record<string, number> {
	let nodes = 0;
	let testIds = 0;
	let patterns = 0;
	let dynamic = 0;
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
		for (const child of node.children) {
			visit(child);
		}
	};
	for (const root of roots) {
		visit(root);
	}
	return { nodes, testIds, patterns, dynamic };
}

interface TreeGap {
	kind: "depth" | "nodes" | "boundary";
	detail: string;
}

/**
 * Why the walk could not see the whole tree, or `null` when it saw all of it.
 *
 * Only cuts that *hide* nodes count: the depth limit and the node budget stop
 * the walk outright, and a component left unexpanded (external module,
 * unresolved reference, JSX children composition) hides whatever it renders.
 * `spread-props` is not one of them — that marks an unknown test id on a node
 * whose children were still walked. `expandedAt` is not one either: the subtree
 * it points at is in this same tree.
 */
function traversalGap(roots: UiNode[], truncated: boolean): TreeGap | null {
	let depthCut = false;
	let boundary: string | undefined;
	const visit = (nodes: UiNode[]): void => {
		for (const node of nodes) {
			const reason = node.unresolved?.reason;
			if (reason === "depth-limit-reached") {
				depthCut = true;
			} else if (
				reason !== undefined &&
				reason !== "spread-props" &&
				node.nodeType === "component"
			) {
				boundary ??= reason;
			}
			visit(node.children);
		}
	};
	visit(roots);

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

function gapHint(
	gap: TreeGap,
	name: string,
	depth: number,
	followComponents: boolean,
): string {
	const findIt = `Pass testId to find where "${name}" is rendered.`;
	if (gap.kind !== "depth") {
		return findIt;
	}
	if (!followComponents) {
		return `Re-call with followComponents: true; it pinned the walk to 1 level. ${findIt}`;
	}
	return depth >= 10
		? `Depth is already at the maximum. ${findIt}`
		: `Re-call with a larger depth (this call walked ${depth}, max 10). ${findIt}`;
}

export function handleMapCoverage(
	workspace: Workspace,
	args: z.infer<typeof mapCoverageInput>,
) {
	let poInclude: string[] | undefined;
	let alsoIncluded: string[] | undefined;
	if (args.file) {
		// Scoping is a path glob, so an unmatched `file` selects zero page objects
		// and the report comes back "successful" with every rendered id uncovered —
		// which reads as a suite that tests nothing and invites edits to page
		// objects that were never in scope. Resolve it against the index first, the
		// way the `class` branch does. Controls count: they are only left out of
		// `list_page_objects`, not out of the coverage scan.
		const index = discoverPageObjects(workspace, { includeControls: true });
		const files = [...new Set(index.pageObjects.map((item) => item.file))];
		const wanted = foldFile(args.file);
		const match = files.find((file) => foldFile(file) === wanted);
		if (!match) {
			throw new ToolError(
				"file_not_found",
				`No page object is declared in "${args.file}".`,
				{
					suggestions: nearbyFiles(args.file, files),
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
			const needle = (args.class ?? "").toLowerCase();
			const suggestions = index.pageObjects
				.filter((item) => item.className.toLowerCase().includes(needle))
				.map((item) => item.className)
				.slice(0, 5);
			throw new ToolError(
				"class_not_found",
				`No page object named "${args.class}" was found.`,
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
	});

	const cap = <T>(list: T[]): T[] => list.slice(0, args.limit);
	const capped = {
		summary: report.summary,
		matched: cap(report.matched),
		...(args.includeUnused
			? { uncoveredTestIds: cap(report.uncoveredTestIds) }
			: {}),
		deadSelectors: cap(report.deadSelectors),
		nonTestIdSelectors: cap(report.nonTestIdSelectors),
		unknownSelectors: cap(report.unknownSelectors),
		unknownTestIds: cap(report.unknownTestIds),
	};

	// Every list that ships capped has to count, or a client reads a partial
	// report as complete. `uncoveredTestIds` only ships when includeUnused is on.
	const truncated =
		report.matched.length > args.limit ||
		(args.includeUnused && report.uncoveredTestIds.length > args.limit) ||
		report.deadSelectors.length > args.limit ||
		report.nonTestIdSelectors.length > args.limit ||
		report.unknownSelectors.length > args.limit ||
		report.unknownTestIds.length > args.limit;

	return ok(capped, {
		attribute: report.attribute,
		attributeSource: args.attribute
			? "param"
			: workspace.testIdAttribute().source,
		playwrightConfig: configFileOf(workspace),
		alsoIncluded,
		warnings: report.warnings,
		truncated,
		// A coverage score computed against the wrong attribute reads as a healthy
		// `1` (zero of zero ids covered) — the one number in this payload nobody
		// double-checks. It gets the loudest treatment.
		hint: environmentHint(report.warnings),
	});
}
