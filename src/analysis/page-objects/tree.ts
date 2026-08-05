import { nearestIds } from "../coverage/suggest";
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
import { docSummary } from "../util/jsdoc";
import { keyFold, splitDefKey, toPosix } from "../util/paths";
import { renderConstructor } from "../util/signature";
import type { Workspace } from "../workspace";
import {
	type DiscoveredClass,
	type DiscoveryResult,
	discoverInternal,
} from "./discover";
import { toInlineTree } from "./inline";
import { LIBRARY_PACKAGE } from "./libraryImports";
import { readMethods } from "./methods";

export interface TreeOptions {
	maxDepth?: number;
	maxNodes?: number;
	includeInherited?: boolean;
	signatureMode?: "syntactic" | "checked";
	format?: "refs" | "inline";
	include?: string[];
	exclude?: string[];
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_NODES = 300;

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
		const { file, name } = splitDefKey(toPosix(trimmed));
		const entry = discovery.classes.get(keyFold(`${file}#${name}`));
		if (entry) {
			return entry;
		}
		const sameName = discovery.byName.get(name) ?? [];
		if (sameName.length > 0) {
			throw new AnalysisTargetError(
				"file_not_found",
				`No class "${name}" in "${file}".`,
				{ candidates: sameName.map((candidate) => candidate.key) },
			);
		}
		throw new AnalysisTargetError(
			"class_not_found",
			`No page object "${name}" found in "${file}".`,
			{ suggestions: suggestionsFor(discovery, name) },
		);
	}

	if (FILE_EXTENSIONS.test(trimmed)) {
		const file = toPosix(trimmed);
		const inFile = [...discovery.classes.values()].filter(
			(entry) => keyFold(entry.file) === keyFold(file),
		);
		if (inFile.length === 1) {
			return inFile[0];
		}
		if (inFile.length > 1) {
			const preferred =
				inFile.find((entry) => entry.declaration.isDefaultExport()) ??
				inFile.find((entry) =>
					entry.classification.hostKind.startsWith("root"),
				);
			if (preferred) {
				return preferred;
			}
			throw new AnalysisTargetError(
				"ambiguous_class",
				`"${file}" declares ${inFile.length} page objects; specify one as "${file}#ClassName".`,
				{ candidates: inFile.map((entry) => entry.key).sort() },
			);
		}
		throw new AnalysisTargetError(
			"file_not_found",
			`No page objects found in "${file}".`,
			{
				suggestions: [
					...new Set(
						[...discovery.classes.values()].map((entry) => entry.file),
					),
				].sort(),
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
			{ candidates: matches.map((entry) => entry.key).sort() },
		);
	}
	throw new AnalysisTargetError(
		"class_not_found",
		`No page object named "${trimmed}" was discovered.`,
		{ suggestions: suggestionsFor(discovery, trimmed) },
	);
}

function suggestionsFor(discovery: DiscoveryResult, name: string): string[] {
	return nearestIds(name, discovery.byName.keys(), 5);
}

/**
 * Builds the definition graph for one page object.
 *
 * The shape is a flat `defs` map plus `$ref`-style string pointers. That makes
 * cycle handling structural rather than defensive: the def shell is inserted
 * into the map *before* its members are walked, so a back-edge naturally
 * becomes a reference to an already-present key and recursion terminates
 * without a visited set. Sharing a control between three parents is free.
 */
export function buildPageObjectTree(
	ws: Workspace,
	target: string,
	options: TreeOptions = {},
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
	const warnings: Diagnostic[] = [];
	let truncated = false;

	const ensureExternal = (ref: string): void => {
		if (defs[ref]) {
			return;
		}
		if (!budget.spend()) {
			truncated = true;
			return;
		}
		defs[ref] = externalStub(ref);
	};

	const ensure = (entry: DiscoveredClass, depth: number): void => {
		if (defs[entry.key]) {
			return;
		}
		if (!budget.spend()) {
			truncated = true;
			defs[entry.key] = {
				...toNode(entry, discovery, options),
				members: [],
				methods: [],
				expanded: false,
			};
			warnings.push(
				warn(
					"node-budget-reached",
					`Node budget of ${budget.maxNodes} definitions reached; "${entry.className}" was emitted as a stub.`,
					{ file: entry.file, line: 0 },
				),
			);
			return;
		}

		const node = toNode(entry, discovery, options);
		// Insert before recursing: this is what makes cycles terminate.
		defs[entry.key] = node;

		if (!budget.allowsDepth(depth + 1)) {
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
	if (options.format === "inline") {
		tree.inline = toInlineTree(tree, { maxDepth: options.maxDepth });
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
	const line = entry.declaration
		.getSourceFile()
		.getLineAndColumnAtPos(entry.declaration.getStart()).line;

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
