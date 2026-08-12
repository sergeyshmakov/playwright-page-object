import { nearestFiles, nearestNames } from "../coverage/suggest";
import {
	AnalysisTargetError,
	dedupeDiagnostics,
	info,
	warn,
} from "../diagnostics";
import type {
	Diagnostic,
	MemberNode,
	PageObjectNode,
	PageObjectTree,
} from "../types";
import { Budget } from "../util/budget";
import { isDefaultExported } from "../util/exports";
import { docSummary } from "../util/jsdoc";
import { keyFold, normalizeRelPath, splitDefKey, toPosix } from "../util/paths";
import { lineAt } from "../util/position";
import { renderConstructor } from "../util/signature";
import type { Workspace } from "../workspace";
import {
	type DiscoveredClass,
	type DiscoveryResult,
	discoverInternal,
} from "./discover";
import { LIBRARY_PACKAGE } from "./libraryImports";
import { readMethods } from "./methods";

export interface TreeOptions {
	maxDepth?: number;
	maxNodes?: number;
	includeInherited?: boolean;
	signatureMode?: "syntactic" | "checked";
	include?: string[];
	exclude?: string[];
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_NODES = 300;
/** A candidate list is for choosing from, not for enumerating a repository. */
const MAX_CANDIDATES = 10;
const MAX_FILE_SUGGESTIONS = 8;

const FILE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Synthetic definitions for library-owned classes, so refs never dangle. */
function externalStub(ref: string): PageObjectNode {
	const { file, name } = splitDefKey(ref);
	const isList = name === "ListPageObject";
	const isRoot = name === "RootPageObject";
	return {
		id: ref,
		className: name,
		file,
		loc: { file, line: 0 },
		hostKind: isRoot ? "rootPageObject" : "nestedPageObject",
		scope: isRoot ? "root-selector" : "parent-locator",
		extendsChain: isList || isRoot ? ["PageObject"] : [],
		inheritedApi:
			name === "PageObject" || isList || isRoot
				? (name as "PageObject" | "ListPageObject" | "RootPageObject")
				: null,
		external: true,
		members: [],
		methods: [],
		expanded: true,
	};
}

function resolveTarget(
	discovery: DiscoveryResult,
	target: string,
): DiscoveredClass {
	const trimmed = target.trim();

	if (trimmed.startsWith("fixture:")) {
		const name = trimmed.slice("fixture:".length);
		const key = discovery.fixtures.byName.get(name);
		const entry = key ? discovery.classes.get(key) : undefined;
		if (!entry) {
			throw new AnalysisTargetError(
				"class_not_found",
				`No page object is bound to the fixture "${name}".`,
				{ suggestions: [...discovery.fixtures.byName.keys()].sort() },
			);
		}
		return entry;
	}

	if (trimmed.includes("#")) {
		const { file, name } = splitDefKey(normalizeRelPath(trimmed));
		const entry = discovery.classes.get(keyFold(`${file}#${name}`));
		if (entry) {
			return entry;
		}
		const sameName = discovery.byName.get(name) ?? [];
		if (sameName.length > 0) {
			throw new AnalysisTargetError(
				"file_not_found",
				`No class "${name}" in "${file}".`,
				{
					candidates: sameName
						.map((candidate) => candidate.key)
						.slice(0, MAX_CANDIDATES),
				},
			);
		}
		throw new AnalysisTargetError(
			"class_not_found",
			`No page object "${name}" found in "${file}".`,
			{ suggestions: suggestionsFor(discovery, name) },
		);
	}

	if (FILE_EXTENSIONS.test(trimmed)) {
		// `./e2e/Home.ts` and `e2e\Home.ts` are the same file the index knows as
		// `e2e/Home.ts`; a caller-supplied spelling must not read as "not found".
		const file = normalizeRelPath(trimmed);
		const inFile = [...discovery.classes.values()].filter(
			(entry) => keyFold(entry.file) === keyFold(file),
		);
		if (inFile.length === 1) {
			return inFile[0];
		}
		if (inFile.length > 1) {
			const preferred =
				inFile.find((entry) => isDefaultExported(entry.declaration)) ??
				inFile.find((entry) =>
					entry.classification.hostKind.startsWith("root"),
				);
			if (preferred) {
				return preferred;
			}
			throw new AnalysisTargetError(
				"ambiguous_class",
				`"${file}" declares ${inFile.length} page objects; specify one as "${file}#ClassName".`,
				{
					candidates: inFile
						.map((entry) => entry.key)
						.sort()
						.slice(0, MAX_CANDIDATES),
				},
			);
		}
		// Ranked, not dumped: one field-test repository has 305 page-object files,
		// and listing every one of them buries the answer and costs more tokens
		// than the tree the caller was asking for.
		throw new AnalysisTargetError(
			"file_not_found",
			`No page objects found in "${file}".`,
			{
				suggestions: nearestFiles(
					file,
					[...discovery.classes.values()].map((entry) => entry.file),
					MAX_FILE_SUGGESTIONS,
				),
			},
		);
	}

	const matches = discovery.byName.get(trimmed) ?? [];
	if (matches.length === 1) {
		return matches[0];
	}
	if (matches.length > 1) {
		throw new AnalysisTargetError(
			"ambiguous_class",
			`${matches.length} classes are named "${trimmed}"; pass "path.ts#${trimmed}" instead.`,
			{
				candidates: matches
					.map((entry) => entry.key)
					.sort()
					.slice(0, MAX_CANDIDATES),
			},
		);
	}
	// An invented name has no plausible near match, and that is the one case
	// where an empty `suggestions` list tells the caller nothing. Naming the size
	// of the index does: zero means the scope found no page objects at all — a
	// different problem with a different fix — and a large number means the name
	// is wrong rather than the scan.
	//
	// It says *distinct names* because that is what this number counts, and it is
	// not the total `list_page_objects` reports. The two differ in both
	// directions: `byName` collapses two classes that share a name into one key,
	// and it covers control classes, which the listing hides unless asked for. On
	// one field repository they read 363 here and 364 there, and an unlabelled
	// number invites the reader to hunt for an off-by-one that is really two
	// different questions.
	const indexed = discovery.byName.size;
	throw new AnalysisTargetError(
		"class_not_found",
		indexed === 0
			? `No page object named "${trimmed}" was discovered, and neither was any other: the scanned sources declare no page objects at all.`
			: `No page object named "${trimmed}" was discovered among the ${indexed} distinct page-object name(s) in the index.`,
		{ suggestions: suggestionsFor(discovery, trimmed) },
	);
}

/**
 * Both passes, not just edit distance.
 *
 * `map_coverage` learned this in cluster C and this path did not, so the same
 * typo answered with suggestions through one tool and with an empty list
 * through the other. See {@link nearestNames} for why one pass is never enough.
 */
function suggestionsFor(discovery: DiscoveryResult, name: string): string[] {
	return nearestNames(name, discovery.byName.keys(), 5);
}

/**
 * Cache identity for one page-object tree: the target plus every option that
 * changes what gets built. `includeMethods` is deliberately not one of them:
 * that is the MCP handler trimming a finished tree, not a different tree.
 */
function treeKey(target: string, options: TreeOptions): string {
	return `po-tree::${JSON.stringify({
		target,
		maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
		maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
		includeInherited: options.includeInherited ?? null,
		signatureMode: options.signatureMode ?? "syntactic",
		include: options.include ?? null,
		exclude: options.exclude ?? null,
	})}`;
}

/**
 * Builds the definition graph for one page object.
 *
 * The shape is a flat `defs` map plus `$ref`-style string pointers. That makes
 * cycle handling structural rather than defensive: the def shell is inserted
 * into the map *before* its members are walked, so a back-edge naturally
 * becomes a reference to an already-present key and recursion terminates
 * without a visited set. Sharing a control between three parents is free.
 *
 * Memoized per epoch, and the result is a wire shape, so callers must read it
 * without writing to it — a handler that trims the returned tree in place would
 * hand the trimmed version to the next caller who asked for the whole thing.
 * A target that resolves to nothing throws, and a throw is never cached.
 */
export function buildPageObjectTree(
	ws: Workspace,
	target: string,
	options: TreeOptions = {},
): PageObjectTree {
	return ws.memo(treeKey(target, options), [], () =>
		computePageObjectTree(ws, target, options),
	);
}

function computePageObjectTree(
	ws: Workspace,
	target: string,
	options: TreeOptions,
): PageObjectTree {
	const startedAt = Date.now();
	const discovery = discoverInternal(ws, {
		include: options.include,
		exclude: options.exclude,
		signatureMode: options.signatureMode,
	});
	const rootEntry = resolveTarget(discovery, target);

	const budget = new Budget(
		options.maxNodes ?? DEFAULT_MAX_NODES,
		options.maxDepth ?? DEFAULT_MAX_DEPTH,
	);
	const defs: Record<string, PageObjectNode> = {};
	// Seeded, not empty: a tree built against an undiscovered Playwright config
	// or an out-of-scope source directory is wrong in ways nothing inside the
	// walk can detect.
	const warnings: Diagnostic[] = [...ws.environmentWarnings()];
	let truncated = false;
	/**
	 * Classes the node budget refused, reported once rather than each.
	 *
	 * A set of refs, not a counter. Both call sites fire per *edge*, so a class
	 * three members point at was counted three times and the warning told the
	 * caller three classes were left out when one was. The number is the reason
	 * they would widen the budget, so it has to be the number of classes.
	 */
	const omitted = new Set<string>();

	const ensureExternal = (ref: string): void => {
		if (defs[ref]) {
			return;
		}
		if (!budget.spend()) {
			// Counted, not warned per ref: the summary below says how many
			// definitions the budget refused, and the outline reads a missing
			// `$ref` as "not expanded: node budget" from that one warning.
			truncated = true;
			omitted.add(ref);
			return;
		}
		defs[ref] = externalStub(ref);
	};

	/**
	 * Whether expanding this class one level further would produce anything.
	 *
	 * A leaf page object — every member a plain `Locator` — has nothing below it,
	 * so stopping at it is not a truncation and saying so invents a hole the
	 * caller then pays depth to go and look for. The check errs towards reporting
	 * the cut: an edge that *might* resolve counts as expandable.
	 *
	 * A definition already in `defs` is not one of them. `defs` is a flat map and
	 * members point into it by `$ref`, so a class whose only edges lead to
	 * definitions the payload already carries is fully readable from where the
	 * walk stopped — expanding it would add nothing. Without that, every self- or
	 * mutually recursive page object reported a depth truncation at the boundary
	 * and sent the caller back for a depth that cannot produce another node.
	 */
	const wouldExpand = (entry: DiscoveredClass): boolean => {
		for (const member of entry.members) {
			for (const edge of member.edges) {
				if (edge.external || !edge.declaration) {
					if (edge.ref.startsWith(`${LIBRARY_PACKAGE}#`) && !defs[edge.ref]) {
						return true;
					}
					continue;
				}
				// Keyed off the discovered class rather than off `edge.ref`, because a
				// case-insensitive filesystem lets the two spellings differ and `defs`
				// is keyed by the canonical one.
				const child = discovery.classes.get(keyFold(edge.ref));
				if (child && !defs[child.key]) {
					return true;
				}
			}
		}
		return false;
	};

	const ensure = (entry: DiscoveredClass, depth: number): void => {
		if (defs[entry.key]) {
			return;
		}
		if (!budget.spend()) {
			// A stub per over-budget class is how the cap stopped capping: the
			// caller loop keeps walking edges, so `defs` grew with the whole
			// reachable class set and the warnings grew one per class with it.
			// Past the budget nothing more is emitted. A member whose `$ref` is
			// now absent reads as "not expanded: node budget" from the single
			// summary warning, which is what the outline already renders.
			truncated = true;
			omitted.add(entry.key);
			return;
		}

		const node = toNode(entry, discovery, options);
		// Insert before recursing: this is what makes cycles terminate.
		defs[entry.key] = node;

		if (!budget.allowsDepth(depth + 1)) {
			if (!wouldExpand(entry)) {
				// Nothing below it, so the boundary is where the tree ends anyway.
				return;
			}
			node.expanded = false;
			truncated = true;
			const diagnostic = info(
				"depth-limit-reached",
				`Depth limit of ${budget.maxDepth} reached at "${entry.className}"; its children were not expanded.`,
				{ file: entry.file, line: node.loc.line },
			);
			node.warnings = [...(node.warnings ?? []), diagnostic];
			warnings.push(diagnostic);
			return;
		}

		for (const member of entry.members) {
			for (const edge of member.edges) {
				if (edge.external || !edge.declaration) {
					if (edge.ref.startsWith(`${LIBRARY_PACKAGE}#`)) {
						ensureExternal(edge.ref);
					}
					continue;
				}
				const child = discovery.classes.get(keyFold(edge.ref));
				if (child) {
					ensure(child, depth + 1);
				}
			}
		}
	};

	ensure(rootEntry, 0);

	if (omitted.size > 0) {
		warnings.push(
			warn(
				"node-budget-reached",
				`Node budget of ${budget.maxNodes} definitions reached; ${omitted.size} more class${omitted.size === 1 ? " was" : "es were"} left out and references to them do not resolve. Re-call with a smaller depth, or address one of the nested classes directly.`,
			),
		);
	}

	let members = 0;
	let methods = 0;
	let dynamic = 0;
	for (const node of Object.values(defs)) {
		members += node.members.length;
		methods += node.methods.length;
		for (const member of node.members) {
			if (isDynamicMember(member)) {
				dynamic += 1;
			}
		}
	}

	const attribute = ws.testIdAttribute();
	const tree: PageObjectTree = {
		schemaVersion: 1,
		projectRoot: toPosix(ws.root),
		testIdAttribute: attribute.attribute,
		testIdAttributeSource: attribute.source,
		root: rootEntry.key,
		defs,
		warnings: dedupeDiagnostics(warnings),
		stats: {
			defs: Object.keys(defs).length,
			members,
			methods,
			dynamic,
			parseMs: Date.now() - startedAt,
		},
	};
	if (truncated) {
		tree.truncated = true;
	}
	return tree;
}

export function isDynamicMember(member: MemberNode): boolean {
	return (
		member.selector.dynamic ||
		member.result.kind === "unknown" ||
		(member.result.kind === "control" && member.result.dynamic === true)
	);
}

/** Projects one discovered class into its wire node. */
export function toNode(
	entry: DiscoveredClass,
	discovery: DiscoveryResult,
	options: TreeOptions,
): PageObjectNode {
	const fixtures = discovery.fixtures.byClass.get(entry.foldedKey) ?? [];
	const line = lineAt(
		entry.declaration.getSourceFile(),
		entry.declaration.getStart(),
	);

	const node: PageObjectNode = {
		id: entry.key,
		className: entry.className,
		file: entry.file,
		loc: { file: entry.file, line },
		hostKind: entry.classification.hostKind,
		scope: entry.classification.scope,
		extendsChain: entry.classification.heritage.chain,
		inheritedApi: entry.classification.heritage.inheritedApi,
		members: entry.members.map((read) => read.member),
		methods: readMethods(entry.declaration, entry.imports, discovery.ctx, {
			signatureMode: options.signatureMode,
			includeInherited: options.includeInherited,
		}),
		expanded: true,
	};

	if (entry.rootSelector) {
		node.rootSelector = entry.rootSelector;
	}
	const [constructorDeclaration] = entry.declaration.getConstructors();
	if (constructorDeclaration) {
		node.ctorSignature = renderConstructor(constructorDeclaration);
	}
	const doc = docSummary(entry.declaration);
	if (doc) {
		node.doc = doc;
	}
	if (fixtures.length > 0) {
		node.fixtures = fixtures;
	}
	const classWarnings = dedupeDiagnostics(entry.warnings);
	if (classWarnings.length > 0) {
		node.warnings = classWarnings;
	}
	return node;
}
