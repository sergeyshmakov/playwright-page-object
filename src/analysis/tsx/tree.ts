import {
	type JsxAttribute,
	Node,
	type SourceFile,
	SyntaxKind,
	type VariableDeclaration,
	VariableDeclarationKind,
} from "ts-morph";
import { dedupeDiagnostics, info } from "../diagnostics";
import type {
	ComponentInfo,
	Diagnostic,
	DiagnosticCode,
	SourceLoc,
	TestIdOccurrence,
	TestIdTree,
	TestIdValue,
	UiNode,
	UiUnresolvedReason,
} from "../types";
import { unwrapTransparent } from "../util/ast";
import { Budget } from "../util/budget";
import { keyFold, matchesAnyGlob, normalizeRelPath } from "../util/paths";
import { lineAndColumnAt } from "../util/position";
import { resolveExportedName } from "../util/resolve";
import { isWorkspaceLocal } from "../util/workspaceRoot";
import { isJsxFile, type Workspace } from "../workspace";
import {
	buildDefinition,
	type ComponentDefinition,
	collectComponents,
	componentReturnExpressions,
	ExternalModuleCensus,
	resolveComponentRef,
} from "./componentGraph";
import {
	isComponentTag,
	isConditionallyRendered,
	isRepeated,
	occurrencesFromElements,
	readExpressionValue,
	type ScannedElement,
	scanFileElements,
	scanFileTestIds,
} from "./scanTestIds";

/**
 * The rule this walk lives by, in one sentence:
 *
 * > **Walk what is syntactically ours; flag what placement we cannot prove;
 * > never drop anything silently.**
 *
 * What that means concretely.
 *
 * **Walked.** Direct JSX children of any element, including the children of a
 * component the walk cannot expand — `<Gapped><div data-tid="X"/></Gapped>` is
 * the caller's own source whatever `Gapped` turns out to be. JSX in the props
 * of a component element, including inside object literals and arrays. One hop
 * to a variable declared in the same component body, including a call with an
 * inline function argument, which is what makes `useMemo(() => <div/>)` work
 * with no `useMemo`-specific code. A *call* to a same-file function that
 * returns JSX — `{getCheckinIcon()}` — inlined at the call site; see
 * {@link TreeBuilder.renderHelperOf}. Conditionals, logical operators,
 * `.map`/`.flatMap` with an inline callback, fragments and type-assertion
 * wrappers.
 *
 * **Flagged, not followed.** Render props the callee invokes; `cloneElement`;
 * `Children.map`; a second variable hop; module-scope or imported JSX
 * constants; `.map(renderItem)` with a non-inline callback; JSX returned by a
 * helper in another file; JSX-valued props on *host* elements (React
 * stringifies those, so walking them would claim an id renders that never
 * does); namespaced tags. Each leaves a `#unresolved` marker node and
 * downgrades `fidelity` to `"partial"`.
 *
 * **Depth counts component-definition boundaries, not DOM nesting.** Slot and
 * prop children are walked at the caller's depth with no increment — they are
 * the caller's source — exactly as host-element children already are.
 */

export interface TestIdTreeOptions {
	attribute?: string;
	/** File path (workspace-relative) whose default export is the tree root. */
	entry?: string;
	/**
	 * Name of the component in `entry` to root the tree at, as reported in
	 * `components[].name`. Only honoured together with `entry`; a component name
	 * is unique within a file, so this is unambiguous. Without it the file is
	 * rooted at its default export, else its first uppercase declaration.
	 */
	entryComponent?: string;
	/**
	 * `false` walks the entry component's own JSX and stops at every component
	 * tag, marking each `not-followed`. Distinct from exhausting `maxDepth`: it
	 * is a caller choice, so it never sets `truncated`.
	 *
	 * @default true
	 */
	followComponents?: boolean;
	include?: string[];
	exclude?: string[];
	maxDepth?: number;
	maxNodes?: number;
}

const DEFAULT_MAX_DEPTH = 6;
/**
 * Raised from 800 when slot and prop children started being walked: a tree that
 * previously terminated at the first design-system wrapper is now five to
 * twenty times larger, and the old cap turned that into a truncated answer on
 * ordinary pages. `stats.nodes` plus `truncated` keep the cost visible.
 */
const DEFAULT_MAX_NODES = 1500;
const ENTRY_BASENAMES = ["main.tsx", "main.jsx", "index.tsx", "index.jsx"];

/**
 * How many per-site diagnostics of one code a tree may emit.
 *
 * Enough to show a reader *where* the walk kept stopping; far short of one per
 * site, which on a deep page meant 46 near-identical entries and a third of the
 * whole response. `tree-partial` carries the exact totals either way.
 */
const MAX_SITE_DIAGNOSTICS = 3;

/** Variable hops one expression walk may take. One, by design — see the header. */
const MAX_VARIABLE_HOPS = 1;

/**
 * Bookkeeping that travels with one expression walk rather than with the node.
 *
 * `position` says whether the expression sits between host tags or was handed
 * to a component; it decides whether an unreadable expression is worth a marker
 * (see {@link TreeBuilder.walkChildren}).
 */
interface WalkScope {
	varHops: number;
	visitedVars?: Set<number>;
	position: "host" | "content";
}

const DEFAULT_SCOPE: WalkScope = {
	varHops: MAX_VARIABLE_HOPS,
	position: "host",
};

interface ExpandState {
	/**
	 * Prop name to the static value the call site passed, by callee-local name.
	 *
	 * A list, non-empty, because a call site may write a static choice:
	 * `<Row rowId={big ? "A" : "B"}/>` passes two ids and both really can render.
	 * Keeping only the first made `B` vanish from the tree *and* from the
	 * inventory, so a selector for it read dead. `[0]` is the one reported as the
	 * id; the rest ride along as `testIdAlternatives`, which is exactly what the
	 * direct (unforwarded) path already does with the same shape.
	 */
	bindings: Map<string, TestIdValue[]>;
	/**
	 * Every prop name the call site wrote, dynamic and value-less ones included,
	 * by callee-local name. This is the evidence of *absence*: a name that is not
	 * here was provably not passed, which is what lets the walk say an attribute
	 * does not render rather than reporting a phantom id.
	 */
	provided: Set<string>;
	/** The call site spread an object onto the element, so unlisted props may still arrive. */
	spreadAtSite: boolean;
	/** `false` only for the tree root, whose caller is outside the analysed tree. */
	callSiteKnown: boolean;
	/** Value passed for the test-id attribute itself at the call site. */
	directAttribute: TestIdValue | null;
	conditional: boolean;
	repeated: boolean;
}

const EMPTY_STATE: ExpandState = {
	bindings: new Map(),
	provided: new Set(),
	spreadAtSite: false,
	// The entry component has no call site inside the analysed tree. Suppressing
	// `data-tid={dataTid}` here would claim "no id renders" from no evidence at
	// all, so every absence inference is gated off at the root.
	callSiteKnown: false,
	directAttribute: null,
	conditional: false,
	repeated: false,
};

/** Field separators that cannot occur in an identifier or in source text. */
const FIELD = "\u0000";
const ITEM = "\u0001";
const PART = "\u0002";
/** Between the branches of one binding, which is itself an `ITEM`. */
const ALT = "\u0003";

function valueSignature(value: TestIdValue): string {
	return [value.kind, value.value ?? "", value.prefix ?? "", value.raw].join(
		FIELD,
	);
}

/**
 * Identity of a component expansion: the component plus everything the call
 * site contributes to it.
 *
 * Everything the memo covers must be a pure function of
 * `(componentRef, ExpandState)`. A component's subtree is site-independent
 * *except* for what flows into it from the call site — the prop values, the
 * evidence of which props were written at all, whether a spread could carry
 * more, and the conditional/repeated context it inherits. Two sites that agree
 * on all of them produce byte-identical subtrees, so the second can reference
 * the first.
 *
 * `provided` / `spreadAtSite` / `callSiteKnown` are in the key because absence
 * is now load-bearing: `<Row/>` and `<Row rowId={x}/>` have identical
 * `bindings` — both empty, since a dynamic value binds nothing — yet the first
 * renders no id at all and the second renders an unreadable one. Collapsing
 * them would report the wrong id state at the second site.
 *
 * Slot and prop children are deliberately absent, and must stay absent. They
 * are never passed into `expandComponent`; they are attached to the render-site
 * node, so they provably cannot change the callee's own subtree. The other half
 * of that rule lives in `element()`: a memo **hit** still emits them, because
 * they belong to the site rather than to the expansion.
 */
function expansionKey(componentRef: string, state: ExpandState): string {
	const bindings = [...state.bindings]
		.map(([name, values]) => `${name}=${values.map(valueSignature).join(ALT)}`)
		.sort()
		.join(ITEM);
	return [
		componentRef,
		bindings,
		[...state.provided].sort().join(ITEM),
		state.spreadAtSite ? "spread" : "",
		state.callSiteKnown ? "called" : "root",
		state.directAttribute ? valueSignature(state.directAttribute) : "",
		state.conditional ? "conditional" : "",
		state.repeated ? "repeated" : "",
	].join(PART);
}

/**
 * The caller's own scope filter, over workspace-relative paths.
 *
 * Shared with the post-walk inventory back-fill so the two cannot drift: a file
 * the caller scoped out must stay out of the inventory however the walk reached
 * it.
 */
function scopeFilter(options: TestIdTreeOptions): (rel: string) => boolean {
	const include = options.include ?? [];
	const exclude = options.exclude ?? [];
	return (rel: string) => {
		if (include.length > 0 && !matchesAnyGlob(rel, include)) {
			return false;
		}
		return !(exclude.length > 0 && matchesAnyGlob(rel, exclude));
	};
}

function selectFiles(ws: Workspace, options: TestIdTreeOptions): SourceFile[] {
	const inScope = scopeFilter(options);
	return ws.jsxFiles().filter((file) => inScope(ws.rel(file.getFilePath())));
}

/**
 * Workspace-relative paths an `entry` can name, in the order the walk searches
 * them.
 *
 * A caller that validates a user-supplied file before calling has to ask the
 * same question {@link findEntryComponent} asks, or the two drift and a path
 * one accepts is a path the other roots nothing at. Exported so nobody
 * re-derives "which files count as an entry" from the outside.
 */
export function entryFileCandidates(
	ws: Workspace,
	options: TestIdTreeOptions = {},
): string[] {
	return selectFiles(ws, options).map((file) => ws.rel(file.getFilePath()));
}

/** What {@link matchEntryPath} made of an `entry` against the scanned files. */
export type EntryPathMatch =
	| { kind: "exact" | "suffix"; file: string }
	| { kind: "ambiguous"; candidates: string[] }
	| { kind: "none" };

/**
 * The scanned path an `entry` names, out of {@link entryFileCandidates}.
 *
 * Exactness wins, always. A suffix is a convenience for `Nested.tsx` standing in
 * for `src/deep/Nested.tsx`, and letting it compete with the exact path in one
 * `.find()` pass handed the answer to whichever file sorted first: a monorepo
 * holding both `src/App.tsx` and `packages/ui/src/App.tsx` rooted the tree at
 * the package when the documented, fully-spelled path named the app. A suffix
 * that fits several files names none of them, and saying so beats picking one.
 *
 * Exported because a caller that validates a user-supplied path before calling
 * has to reach the same verdict this walk does. A second implementation of
 * "which scanned file is this?" outside the engine rewrote the request before
 * the rule below ever saw it, which put the monorepo bug back one layer up.
 */
export function matchEntryPath(
	candidates: readonly string[],
	entry: string,
): EntryPathMatch {
	const wanted = keyFold(normalizeRelPath(entry));
	const suffix: string[] = [];
	for (const rel of candidates) {
		const folded = keyFold(rel);
		if (folded === wanted) {
			return { kind: "exact", file: rel };
		}
		if (folded.endsWith(`/${wanted}`)) {
			suffix.push(rel);
		}
	}
	if (suffix.length === 1) {
		return { kind: "suffix", file: suffix[0] };
	}
	if (suffix.length > 1) {
		return { kind: "ambiguous", candidates: [...suffix].sort() };
	}
	return { kind: "none" };
}

function matchEntryFile(
	ws: Workspace,
	files: SourceFile[],
	entry: string,
):
	| { kind: "exact" | "suffix"; file: SourceFile }
	| { kind: "ambiguous"; candidates: string[] }
	| { kind: "none" } {
	const byRel = new Map<string, SourceFile>();
	for (const file of files) {
		byRel.set(ws.rel(file.getFilePath()), file);
	}
	const matched = matchEntryPath([...byRel.keys()], entry);
	if (matched.kind === "ambiguous" || matched.kind === "none") {
		return matched;
	}
	const file = byRel.get(matched.file);
	return file ? { kind: matched.kind, file } : { kind: "none" };
}

function findEntryComponent(
	ws: Workspace,
	files: SourceFile[],
	options: TestIdTreeOptions,
): { definition: ComponentDefinition | null; reason?: string } {
	const resolveFrom = (
		sourceFile: SourceFile,
		tag: string,
	): ComponentDefinition | null => {
		const resolution = resolveComponentRef(ws, ws.project, sourceFile, tag, {
			preferSyntacticResolution: ws.options.preferSyntacticResolution ?? true,
		});
		return resolution.kind === "local" ? resolution.definition : null;
	};

	if (options.entry) {
		const matched = matchEntryFile(ws, files, options.entry);
		if (matched.kind === "none") {
			return {
				definition: null,
				reason: `Entry file "${options.entry}" was not found among the scanned files.`,
			};
		}
		if (matched.kind === "ambiguous") {
			return {
				definition: null,
				reason: `Entry file "${options.entry}" matches ${matched.candidates.length} scanned files (${matched.candidates.slice(0, 5).join(", ")}); pass the workspace-relative path.`,
			};
		}
		const target = matched.file;
		if (options.entryComponent) {
			const named = componentNamed(ws, target, options.entryComponent);
			if (named) {
				return { definition: named };
			}
			const declared = uppercaseDeclarationsIn(target);
			const alternatives =
				declared.length > 0
					? ` It declares ${declared.map((name) => `"${name}"`).join(", ")}.`
					: "";
			return {
				definition: null,
				reason: `Entry file "${options.entry}" does not declare a component named "${options.entryComponent}".${alternatives}`,
			};
		}
		const own = firstComponentIn(ws, target);
		if (own) {
			return { definition: own };
		}
		return {
			definition: null,
			reason: `Entry file "${options.entry}" does not declare a component.`,
		};
	}

	// Nothing is guessed for a bare `entryComponent`: searching every file for a
	// name would answer with whichever file was scanned first, and the caller
	// that knows the symbol always knows its file.
	if (options.entryComponent) {
		return {
			definition: null,
			reason: `entryComponent "${options.entryComponent}" needs an entry file; a component name is only unique within one file.`,
		};
	}

	// `main.tsx` renders the real root; follow the first local component it uses.
	const bootstraps = files
		.filter((file) => ENTRY_BASENAMES.includes(file.getBaseName()))
		.sort((a, b) => a.getFilePath().length - b.getFilePath().length);
	for (const bootstrap of bootstraps) {
		for (const element of [
			...bootstrap.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
			...bootstrap.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
		]) {
			const tag = element.getTagNameNode().getText();
			if (!/^[A-Z]/.test(tag)) {
				continue;
			}
			const definition = resolveFrom(bootstrap, tag);
			if (definition) {
				return { definition };
			}
		}
	}

	const app = files.find((file) =>
		/(^|\/)App\.[jt]sx$/.test(file.getFilePath()),
	);
	if (app) {
		const definition = firstComponentIn(ws, app);
		if (definition) {
			return { definition };
		}
	}

	return {
		definition: null,
		reason:
			"No entry could be auto-detected (looked for main/index bootstrap files and an App component).",
	};
}

/** Uppercase declarations a file offers, for a "did you mean" reason string. */
function uppercaseDeclarationsIn(sourceFile: SourceFile): string[] {
	const names = new Set<string>();
	for (const declaration of sourceFile.getFunctions()) {
		const name = declaration.getName();
		if (name && /^[A-Z]/.test(name)) {
			names.add(name);
		}
	}
	for (const declaration of sourceFile.getVariableDeclarations()) {
		const name = declaration.getName();
		if (/^[A-Z]/.test(name)) {
			names.add(name);
		}
	}
	return [...names].sort();
}

/**
 * The component a caller named explicitly, in the file they named it in.
 *
 * No uppercase filter anywhere: the caller wrote the name, so a lowercase one
 * is their business. The only rejection is `buildDefinition` refusing something
 * that is not a function component.
 */
function componentNamed(
	ws: Workspace,
	sourceFile: SourceFile,
	name: string,
): ComponentDefinition | null {
	// The default export first, and by the name it *reports*: `declaredNameOf`
	// gives an anonymous `export default () => …` the file's basename, so
	// `Foo.tsx` is addressable as "Foo" even though no declaration in it is
	// literally named that.
	const defaultExport = resolveExportedName(ws.project, sourceFile, "default");
	if (
		defaultExport &&
		isWorkspaceLocal(ws.project, defaultExport.sourceFile.getFilePath())
	) {
		const built = buildDefinition(
			ws,
			defaultExport.declaration,
			defaultExport.name,
		);
		if (built && built.name === name) {
			return built;
		}
	}

	const fn = sourceFile.getFunction(name);
	if (fn) {
		const built = buildDefinition(ws, fn, name);
		if (built) {
			return built;
		}
	}
	const variable = sourceFile.getVariableDeclaration(name);
	if (variable) {
		const built = buildDefinition(ws, variable, name);
		if (built) {
			return built;
		}
	}

	// A barrel `export { Beta } from "./Beta"` names a component this file does
	// not declare. It is keyed off the *declaring* file, exactly as the
	// default-export path documents in `firstComponentIn`.
	const exported = resolveExportedName(ws.project, sourceFile, name);
	if (
		exported &&
		isWorkspaceLocal(ws.project, exported.sourceFile.getFilePath())
	) {
		return buildDefinition(ws, exported.declaration, exported.name);
	}
	return null;
}

function firstComponentIn(
	ws: Workspace,
	sourceFile: SourceFile,
): ComponentDefinition | null {
	// The default export first, whether or not it has a name of its own:
	// `export default function () {}` and `export default () => …` are the only
	// component plenty of files declare, and skipping them dropped the whole tree
	// to a flat inventory that claimed the file declared nothing.
	//
	// The declaration is taken wherever the resolver found it, including another
	// file: `src/index.tsx` doing `export { default } from "./App"` is an
	// ordinary React entry point, and rejecting it because the declaration lives
	// in `App.tsx` dropped that entry to flat fidelity too. `buildDefinition`
	// keys the definition off the *declaring* file, so the root still comes back
	// as `src/App.tsx#default` — the same id `collectComponents` minted for it.
	// A declaration in an installed dependency is a boundary the scanner reports
	// rather than crosses, exactly as `resolveComponentRef` treats an imported
	// tag — and, just as there, a workspace package linked through
	// `node_modules` is not one.
	const defaultExport = resolveExportedName(ws.project, sourceFile, "default");
	if (
		defaultExport &&
		isWorkspaceLocal(ws.project, defaultExport.sourceFile.getFilePath())
	) {
		const built = buildDefinition(
			ws,
			defaultExport.declaration,
			defaultExport.name,
		);
		// A named default export still has to look like a component, so a file
		// whose default export is a lowercase helper keeps falling through to the
		// component loops below. An anonymous one has no name to judge.
		if (
			built &&
			(defaultExport.name === "default" || /^[A-Z]/.test(built.name))
		) {
			return built;
		}
	}
	for (const declaration of sourceFile.getFunctions()) {
		const name = declaration.getName();
		if (name && /^[A-Z]/.test(name)) {
			return buildLocal(ws, sourceFile, name);
		}
	}
	for (const declaration of sourceFile.getVariableDeclarations()) {
		const name = declaration.getName();
		if (/^[A-Z]/.test(name)) {
			const built = buildLocal(ws, sourceFile, name);
			if (built) {
				return built;
			}
		}
	}
	return null;
}

function buildLocal(
	ws: Workspace,
	sourceFile: SourceFile,
	name: string,
): ComponentDefinition | null {
	const resolution = resolveComponentRef(ws, ws.project, sourceFile, name, {
		preferSyntacticResolution: true,
	});
	return resolution.kind === "local" ? resolution.definition : null;
}

interface TreeShape {
	nodes: number;
	slots: number;
	unresolved: number;
	/** Keyed by reason, zero entries absent — the wire shape, built directly. */
	unresolvedByReason: Partial<Record<UiUnresolvedReason, number>>;
}

/**
 * Counts the shape of the emitted tree.
 *
 * `spread-props` is counted nowhere: it marks an unknown *value* on a node
 * whose children are all present, not a missing subtree. Treating it as a hole
 * would make almost every real repository permanently `"partial"` and destroy
 * the signal that word carries.
 */
function measureTree(roots: UiNode[]): TreeShape {
	const shape: TreeShape = {
		nodes: 0,
		slots: 0,
		unresolved: 0,
		unresolvedByReason: {},
	};
	const visit = (node: UiNode): void => {
		shape.nodes += 1;
		if (node.placement) {
			shape.slots += 1;
		}
		const reason = node.unresolved?.reason;
		if (reason && reason !== "spread-props") {
			shape.unresolved += 1;
			shape.unresolvedByReason[reason] =
				(shape.unresolvedByReason[reason] ?? 0) + 1;
		}
		for (const child of node.children) {
			visit(child);
		}
	};
	for (const root of roots) {
		visit(root);
	}
	return shape;
}

function partialReason(shape: TreeShape, budgetExhausted: boolean): string {
	const breakdown = Object.entries(shape.unresolvedByReason)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([reason, count]) => `${reason} ×${count}`)
		.join(", ");
	if (shape.unresolved === 0) {
		return "A traversal budget stopped the walk before it finished; ids beyond the cut are missing from roots but present in inventory.";
	}
	const budgetNote = budgetExhausted
		? " A traversal budget also stopped the walk."
		: "";
	return `${shape.unresolved} of ${shape.nodes} nodes were left unexpanded (${breakdown}); ids inside them are missing from roots but present in inventory.${budgetNote}`;
}

/**
 * Cache identity for one tree: every option that changes what is built.
 *
 * `attribute` is the caller's raw value, not the resolved one. Passing the
 * workspace default explicitly reports `attributeSource: "param"`, which is a
 * different answer to the same-looking question.
 *
 * Nothing about *presentation* belongs here. `format`, `limit` and `offset` are
 * applied by the MCP handlers to the finished tree, so keying on them would
 * build the same tree once per rendering.
 */
function treeKey(options: TestIdTreeOptions): string {
	return `testid-tree::${JSON.stringify({
		attribute: options.attribute ?? null,
		entry: options.entry ?? null,
		entryComponent: options.entryComponent ?? null,
		followComponents: options.followComponents !== false,
		include: options.include ?? null,
		exclude: options.exclude ?? null,
		maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
		maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
	})}`;
}

/**
 * Builds the UI test-id tree.
 *
 * `inventory` is complete in every fidelity mode on purpose: coverage runs off
 * the inventory, not the tree, so a component that exists but is unreachable
 * from the auto-detected entry must never become "dead selector" fuel.
 *
 * Memoized per epoch. The result is a wire shape — plain JSON all the way
 * down, no `Node` or `SourceFile` anywhere in it — so a cached tree cannot
 * outlive the AST it was read from. Callers must treat it as shared and read
 * it without writing to it.
 */
export function buildTestIdTree(
	ws: Workspace,
	options: TestIdTreeOptions = {},
): TestIdTree {
	return ws.memo(treeKey(options), [], () => computeTestIdTree(ws, options));
}

/**
 * Every component the scan can see, without building a tree for it.
 *
 * A caller that only needs the component *inventory* — to resolve a name to a
 * file, or to list what a file declares — was building a whole depth-1 tree and
 * reading one field off it, which meant scanning every JSX file for test ids and
 * running a walk whose output was discarded. This is the field on its own; it is
 * exactly what {@link buildTestIdTree} puts in `components`, computed the same
 * way from the same file set.
 */
export function scannedComponents(
	ws: Workspace,
	options: Pick<TestIdTreeOptions, "include" | "exclude"> = {},
): Record<string, ComponentInfo> {
	const key = `components::${JSON.stringify({
		include: options.include ?? null,
		exclude: options.exclude ?? null,
	})}`;
	return ws.memo(key, [], () =>
		collectComponents(ws, selectFiles(ws, options)),
	);
}

function computeTestIdTree(
	ws: Workspace,
	options: TestIdTreeOptions,
): TestIdTree {
	const startedAt = Date.now();
	const resolvedAttribute = options.attribute
		? { attribute: options.attribute, source: "param" as const }
		: ws.testIdAttribute();
	const attribute = resolvedAttribute.attribute;
	const files = selectFiles(ws, options);
	// The attribute actually used, not the workspace default: a per-call override
	// is exactly the case where the census has to check the name that was read.
	const warnings: Diagnostic[] = [...ws.environmentWarnings(attribute)];

	const inventory: TestIdOccurrence[] = [];
	const scannedPaths = new Set<string>();
	// One JSX descent per file feeds both the inventory and the scope census.
	const census = new ExternalModuleCensus(ws);
	for (const sourceFile of files) {
		const rel = ws.rel(sourceFile.getFilePath());
		const elements = scanFileElements(sourceFile, attribute, rel);
		inventory.push(...occurrencesFromElements(elements, rel));
		census.add(sourceFile, elements);
		scannedPaths.add(sourceFile.getFilePath());
	}
	const externals = census.evidence();

	const components = collectComponents(ws, files);
	const budget = new Budget(
		options.maxNodes ?? DEFAULT_MAX_NODES,
		options.maxDepth ?? DEFAULT_MAX_DEPTH,
	);
	const entry = findEntryComponent(ws, files, options);

	let roots: UiNode[] = [];
	let fidelity: TestIdTree["fidelity"] = "flat";
	let fidelityReason: string | undefined = entry.reason;
	let shape: TreeShape = {
		nodes: 0,
		slots: 0,
		unresolved: 0,
		unresolvedByReason: {},
	};
	let extraFiles = 0;

	if (entry.definition) {
		const builder = new TreeBuilder(
			ws,
			attribute,
			budget,
			warnings,
			options.followComponents !== false,
		);
		roots = builder.expandComponent(
			entry.definition,
			0,
			new Set<string>(),
			EMPTY_STATE,
		);
		extraFiles = backfillInventory(
			ws,
			attribute,
			scopeFilter(options),
			inventory,
			scannedPaths,
			builder.visitedFiles,
			warnings,
		);
		mergeResolvedOccurrences(inventory, roots);

		shape = measureTree(roots);
		if (shape.unresolved > 0 || budget.exhausted) {
			fidelity = "partial";
			fidelityReason = partialReason(shape, budget.exhausted);
			// The counts above are exact; the individual site entries beside them
			// are not, and a reader counting three of them would undercount badly.
			const sampled = builder
				.sampledSites()
				.map((one) => `${one.shown} of ${one.total} ${one.code}`)
				.join(", ");
			warnings.push(
				info(
					"tree-partial",
					sampled
						? `${fidelityReason} Per-site entries in this response are a sample (${sampled}); the counts here are exact.`
						: fidelityReason,
				),
			);
		} else {
			fidelity = "full";
			fidelityReason = undefined;
		}
		if (shape.unresolvedByReason["not-followed"]) {
			warnings.push(
				info(
					"components-not-followed",
					`followComponents was off, so ${shape.unresolvedByReason["not-followed"]} component tag(s) were reported without expanding them. Re-call with followComponents: true to see inside.`,
				),
			);
		}
	} else if (fidelityReason) {
		warnings.push(info("entry-not-found", fidelityReason));
	}

	const dynamic = inventory.filter(
		(occurrence) => occurrence.value.kind === "dynamic",
	).length;

	const tree: TestIdTree = {
		schemaVersion: 1,
		scanner: "jsx",
		attribute,
		attributeSource: resolvedAttribute.source,
		fidelity,
		roots,
		inventory,
		components,
		externalModules: externals.modules,
		externalModuleCount: externals.moduleCount,
		linkedExternalModules: externals.linkedModules,
		linkedExternalModuleCount: externals.linkedCount,
		warnings: dedupeDiagnostics(warnings),
		stats: {
			files: files.length + extraFiles,
			occurrences: inventory.length,
			dynamic,
			parseMs: Date.now() - startedAt,
			externalComponentTags: externals.tags,
			nodes: shape.nodes,
			unresolved: shape.unresolved,
			unresolvedByReason: shape.unresolvedByReason,
			slots: shape.slots,
		},
	};
	if (fidelityReason) {
		tree.fidelityReason = fidelityReason;
	}
	if (externals.sourceRoot) {
		tree.externalModuleRoot = externals.sourceRoot;
	}
	if (budget.exhausted) {
		tree.truncated = true;
	}
	return tree;
}

/**
 * Scans files the *walk* reached but the *scan* never saw, and returns how many
 * were added to the inventory.
 *
 * The two sets can diverge because `Workspace.sourceFiles()` is memoized per
 * epoch while the resolver adds files to the project on demand without bumping
 * it — an alias target, a `.js` module, a workspace package behind a
 * `node_modules` link. Their ids would land in `roots` and never in
 * `inventory`, and coverage, which reads only the inventory, would report every
 * selector for them as a dead selector.
 *
 * A file the caller scoped out on purpose stays out, but the divergence is
 * stated rather than hidden: silence there is the same wrong answer in the
 * other direction.
 */
function backfillInventory(
	ws: Workspace,
	attribute: string,
	inScope: (rel: string) => boolean,
	inventory: TestIdOccurrence[],
	scanned: Set<string>,
	visited: Set<SourceFile>,
	warnings: Diagnostic[],
): number {
	let added = 0;
	const outOfScope: string[] = [];
	for (const sourceFile of visited) {
		const absolute = sourceFile.getFilePath();
		if (scanned.has(absolute) || !isJsxFile(absolute)) {
			continue;
		}
		scanned.add(absolute);
		const rel = ws.rel(absolute);
		if (!ws.analysable(sourceFile) || !inScope(rel)) {
			outOfScope.push(rel);
			continue;
		}
		inventory.push(...scanFileTestIds(sourceFile, attribute, rel));
		added += 1;
	}
	if (outOfScope.length > 0) {
		warnings.push(
			info(
				"inventory-scope-gap",
				`The tree walked into ${outOfScope.length} file(s) outside the requested scope, so their ids are in roots but not in inventory: ${outOfScope.sort().slice(0, 5).join(", ")}.`,
			),
		);
	}
	return added;
}

/**
 * Folds ids that only became knowable through one-hop prop forwarding back into
 * the flat inventory, and drops the `dynamic` placeholder they replace.
 *
 * Indistinguishable occurrences are collapsed: one source location reached from
 * two render sites that bound the same value with the same flags is one fact,
 * and collapsing it keeps the inventory identical whether or not the tree
 * de-duplicated those sites. Sites that bind *different* values at the same
 * location still contribute one occurrence each — that is exactly the set
 * coverage needs.
 *
 * `testIdAbsent` nodes are deliberately **not** removed from the inventory. The
 * same component may be rendered elsewhere, outside the walked entry tree, with
 * the prop passed; deleting the dynamic occurrence would manufacture a false
 * "dead selector" for a page object that works. The tree node is corrected, and
 * the inventory occurrence stays in coverage's `unknown` bucket where it
 * belongs.
 *
 * The placeholder only goes when *every* site that reached a location was
 * readable. One `<Row dataTid="Known" />` next to one `<Row dataTid={runtime} />`
 * resolves the first and learns nothing from the second, and dropping the
 * placeholder on the strength of the first reported the second site's id as
 * dead rather than unknown.
 */
function mergeResolvedOccurrences(
	inventory: TestIdOccurrence[],
	roots: UiNode[],
): void {
	const resolved: TestIdOccurrence[] = [];
	const resolvedLocs = new Set<string>();
	const unknownLocs = new Set<string>();
	const seen = new Set<string>();

	const visit = (node: UiNode) => {
		const at = `${node.loc.file}:${node.loc.line}:${node.loc.column ?? 0}`;
		if (node.testId && (node.viaProp || node.viaSpread || node.viaDefault)) {
			const key = at;
			resolvedLocs.add(key);
			// Every branch of a static choice the call site wrote, not only the one
			// reported as `testId`. This list is what coverage matches selectors
			// against, and a branch missing from it comes back as a dead selector
			// for an id that renders — while the placeholder that would have said
			// "unknown" was just deleted a few lines below.
			for (const value of [node.testId, ...(node.testIdAlternatives ?? [])]) {
				const occurrence: TestIdOccurrence = {
					value,
					file: node.file,
					loc: node.loc,
					tag: node.tag,
					component: node.component,
					// One hop of forwarding proven, but when the id landed on another
					// component rather than on a host element it is still a prop, and
					// still unproven.
					reach: node.nodeType === "component" ? "component-prop" : "forwarded",
				};
				if (node.conditional) {
					occurrence.conditional = true;
				}
				if (node.repeated) {
					occurrence.repeated = true;
				}
				if (node.viaProp) {
					occurrence.viaProp = node.viaProp;
				}
				const identity = [
					key,
					valueSignature(value),
					occurrence.conditional ? "conditional" : "",
					occurrence.repeated ? "repeated" : "",
					occurrence.viaProp ?? "",
					node.viaDefault ? "default" : "",
				].join(PART);
				if (!seen.has(identity)) {
					seen.add(identity);
					resolved.push(occurrence);
				}
			}
		} else if (node.testId?.kind === "dynamic") {
			// This site was reached and stayed unreadable, so the placeholder at
			// this location is still the only record of what it renders.
			unknownLocs.add(at);
		}
		for (const child of node.children) {
			visit(child);
		}
	};
	for (const root of roots) {
		visit(root);
	}
	if (resolved.length === 0) {
		return;
	}

	for (let index = inventory.length - 1; index >= 0; index -= 1) {
		const occurrence = inventory[index];
		if (occurrence.value.kind !== "dynamic") {
			continue;
		}
		const key = `${occurrence.loc.file}:${occurrence.loc.line}:${occurrence.loc.column ?? 0}`;
		if (resolvedLocs.has(key) && !unknownLocs.has(key)) {
			inventory.splice(index, 1);
		}
	}
	inventory.push(...resolved);
}

/** What the walk decided one render site's test-id expression resolves to. */
type SiteValue =
	| {
			kind: "value";
			value: TestIdValue;
			/** The other branches of a static choice, when the call site wrote one. */
			alternatives?: TestIdValue[];
			viaProp?: string;
			viaDefault?: true;
	  }
	/** The attribute is written but provably renders nothing at this site. */
	| { kind: "absent" }
	/** Not knowable from here: report it dynamic, as before. */
	| { kind: "unknown" };

class TreeBuilder {
	/** Per-file element index, keyed by node start offset. */
	private readonly scanCache = new Map<string, Map<number, ScannedElement>>();

	/** Local variable declarations per component body, built on first use. */
	private readonly localVariables = new Map<
		string,
		Map<string, VariableDeclaration>
	>();

	/** Same-file functions that could be render helpers, per component body. */
	private readonly helpers = new Map<string, Map<string, Node>>();

	/**
	 * Render helpers being inlined right now, by file and declaration offset.
	 *
	 * The cycle guard for {@link TreeBuilder.walkRenderHelper}: a helper that
	 * calls itself, or two that call each other, would otherwise walk forever.
	 */
	private readonly activeHelpers = new Set<string>();

	/**
	 * How many per-site diagnostics each code has produced, and how many of them
	 * were actually emitted. See {@link TreeBuilder.noteSite}.
	 */
	private readonly siteCounts = new Map<DiagnosticCode, number>();

	/**
	 * Every file the walk actually read. `buildTestIdTree` reconciles this with
	 * the scan set so a file the resolver pulled in mid-walk still reaches the
	 * inventory.
	 */
	readonly visitedFiles = new Set<SourceFile>();

	/**
	 * Expansion key to the render site that already expanded it in full.
	 *
	 * Only *self-contained* expansions are recorded — see {@link boundaries}.
	 */
	private readonly expansions = new Map<string, SourceLoc>();

	/**
	 * Count of places the walk stopped early for a reason that depends on where
	 * it was, rather than on what it was expanding: the recursion guard, the
	 * depth limit and the node budget.
	 *
	 * An expansion that bumped this counter is only valid at the site that
	 * produced it — a different site has a different ancestor path, a different
	 * depth and a different amount of budget left — so it is never memoized.
	 */
	private boundaries = 0;

	/**
	 * Nodes this walk put in the tree. Counted here rather than read off the
	 * budget because the last slot is claimed before it is emitted — see
	 * {@link spendNode} — and {@link walkChildren} has to be able to tell "this
	 * child produced nothing because the budget is gone" from "this child cost
	 * nodes and still produced nothing".
	 */
	private emitted = 0;

	/**
	 * The one node slot held back for a `node-budget-reached` marker.
	 *
	 * The marker is a node in the returned tree like every other one. Appending
	 * it after the cap was reached charged nothing, and a deeply nested tree
	 * unwinds through one child list per ancestor, each appending another: a
	 * `maxNodes: 5` walk returned ten nodes. Claiming the final slot up front
	 * makes the cap a bound on what ships, and one marker — at the innermost
	 * list, where the walk actually stopped — is what it buys.
	 */
	private markerSlot: "free" | "held" | "spent" = "free";

	constructor(
		private readonly ws: Workspace,
		private readonly attribute: string,
		private readonly budget: Budget,
		private readonly warnings: Diagnostic[],
		private readonly followComponents: boolean,
	) {}

	/**
	 * Records a diagnostic that fires once per *site*, emitting only the first
	 * few.
	 *
	 * A deep component tree hits the depth limit at dozens of places, and each
	 * one used to become its own warning: measured on one production page, 46
	 * `depth-limit-reached` entries, 14,698 bytes of `meta.warnings` on a 43,402
	 * byte response — a third of it. They said one thing 46 times, and the same
	 * response already stated it exactly once, with an exact count, in
	 * `tree-partial` ("… depth-limit-reached ×49 …").
	 *
	 * The session warning ledger cannot help here: every site has its own `loc`,
	 * so all 46 are new on the first call, which is the call that hurts. A few
	 * examples are worth keeping — a reader wants to see *where* — so the first
	 * few ship and {@link TreeBuilder.sampledSites} reports what that cost.
	 */
	private noteSite(
		code: DiagnosticCode,
		message: string,
		loc: SourceLoc | undefined,
	): void {
		const seen = this.siteCounts.get(code) ?? 0;
		this.siteCounts.set(code, seen + 1);
		if (seen < MAX_SITE_DIAGNOSTICS) {
			this.warnings.push(info(code, message, loc));
		}
	}

	/** Codes whose per-site diagnostics were cut, and by how much. */
	sampledSites(): Array<{
		code: DiagnosticCode;
		shown: number;
		total: number;
	}> {
		const out: Array<{ code: DiagnosticCode; shown: number; total: number }> =
			[];
		for (const [code, total] of this.siteCounts) {
			if (total > MAX_SITE_DIAGNOSTICS) {
				out.push({ code, shown: MAX_SITE_DIAGNOSTICS, total });
			}
		}
		return out;
	}

	/**
	 * Spends one node on tree content, keeping the marker slot back.
	 *
	 * The budget still records the refusal — `truncated` and the partial-fidelity
	 * reason are read off it — which is why the reserved slot is taken from it
	 * rather than simply subtracted from the cap.
	 */
	private spendNode(): boolean {
		if (
			this.markerSlot === "free" &&
			this.budget.spent + 1 >= this.budget.maxNodes
		) {
			this.budget.spend();
			this.budget.spend();
			this.markerSlot = "held";
			return false;
		}
		if (!this.budget.spend()) {
			return false;
		}
		this.emitted += 1;
		return true;
	}

	private scannedAt(
		owner: ComponentDefinition,
		start: number,
	): ScannedElement | undefined {
		const path = owner.sourceFile.getFilePath();
		let index = this.scanCache.get(path);
		if (!index) {
			index = new Map<number, ScannedElement>();
			for (const element of scanFileElements(
				owner.sourceFile,
				this.attribute,
				owner.file,
			)) {
				index.set(element.node.getStart(), element);
			}
			this.scanCache.set(path, index);
			this.visitedFiles.add(owner.sourceFile);
		}
		return index.get(start);
	}

	expandComponent(
		definition: ComponentDefinition,
		depth: number,
		path: Set<string>,
		state: ExpandState,
	): UiNode[] {
		if (path.has(definition.id)) {
			this.boundaries += 1;
			return [];
		}
		this.visitedFiles.add(definition.sourceFile);
		const nextPath = new Set(path);
		nextPath.add(definition.id);

		const returns = componentReturnExpressions(definition.fn);
		if (returns.length === 0) {
			return [];
		}
		if (returns.length === 1) {
			return this.walk(returns[0], definition, depth, nextPath, state);
		}
		// Several `return` statements: each is a mutually exclusive branch.
		//
		// The wrapper is a node in the payload like every other one, so it is
		// charged before it is built. Mapping the returns straight into the result
		// spent nothing at all, and a component with nine branches shipped nine
		// nodes through a `maxNodes: 3` walk — the same overshoot the
		// `node-budget-reached` marker had, one node shape further out.
		const branches: UiNode[] = [];
		for (const expression of returns) {
			if (!this.spendNode()) {
				// The reserve exists for exactly this cut: no node left to charge, and
				// the loss real. Breaking without spending it shipped three branches of
				// nine and said nothing about the other six — the payload reads as a
				// complete list of what the component can return.
				if (this.markerSlot === "held") {
					this.markerSlot = "spent";
					branches.push(
						this.markerNode(definition, expression, "node-budget-reached"),
					);
				}
				break;
			}
			const position = lineAndColumnAt(
				definition.sourceFile,
				expression.getStart(),
			);
			branches.push({
				tag: "#branch",
				nodeType: "branch" as const,
				file: definition.file,
				loc: {
					file: definition.file,
					line: position.line,
					column: position.column,
				},
				component: definition.name,
				conditional: true,
				children: this.walk(expression, definition, depth, nextPath, {
					...state,
					conditional: true,
				}),
			});
		}
		return branches;
	}

	private walk(
		node: Node,
		owner: ComponentDefinition,
		depth: number,
		path: Set<string>,
		state: ExpandState,
		scope: WalkScope = DEFAULT_SCOPE,
	): UiNode[] {
		const recur = (next: Node, overrides?: Partial<ExpandState>): UiNode[] =>
			this.walk(
				next,
				owner,
				depth,
				path,
				overrides ? { ...state, ...overrides } : state,
				scope,
			);

		if (Node.isParenthesizedExpression(node)) {
			return recur(node.getExpression());
		}
		if (
			Node.isAsExpression(node) ||
			Node.isNonNullExpression(node) ||
			Node.isTypeAssertion(node) ||
			Node.isSatisfiesExpression(node)
		) {
			return recur(node.getExpression());
		}
		if (Node.isJsxExpression(node)) {
			const expression = node.getExpression();
			return expression ? recur(expression) : [];
		}
		if (Node.isJsxFragment(node)) {
			// A fragment is transparent: its children sit exactly where it sits, so
			// they inherit the position rather than resetting it.
			return this.walkChildren(
				node.getJsxChildren(),
				owner,
				depth,
				path,
				state,
				scope.position,
			);
		}
		if (Node.isJsxElement(node)) {
			return this.element(
				node.getOpeningElement(),
				node.getJsxChildren(),
				owner,
				depth,
				path,
				state,
			);
		}
		if (Node.isJsxSelfClosingElement(node)) {
			return this.element(node, [], owner, depth, path, state);
		}
		if (Node.isConditionalExpression(node)) {
			return [
				...recur(node.getWhenTrue(), { conditional: true }),
				...recur(node.getWhenFalse(), { conditional: true }),
			];
		}
		if (Node.isBinaryExpression(node)) {
			const operator = node.getOperatorToken().getKind();
			if (
				operator === SyntaxKind.AmpersandAmpersandToken ||
				operator === SyntaxKind.BarBarToken ||
				operator === SyntaxKind.QuestionQuestionToken
			) {
				// The left operand carries JSX in `{a || <Fallback/>}` written the
				// other way round (`{<Primary/> || a}`) and, far more commonly, in
				// `{<A/>}{cond && <B/>}` chains the parser nests leftwards.
				const left = containsJsx(node.getLeft())
					? recur(node.getLeft(), { conditional: true })
					: [];
				return [...left, ...recur(node.getRight(), { conditional: true })];
			}
			return [];
		}
		if (Node.isArrayLiteralExpression(node)) {
			return node.getElements().flatMap((element) => recur(element));
		}
		if (Node.isObjectLiteralExpression(node)) {
			// `reactParams={{ Name: <span data-tid="N"/> }}` — the i18n shape. The
			// value is JSX the caller wrote; only its placement is unproven.
			return node.getProperties().flatMap((property) => {
				if (!Node.isPropertyAssignment(property)) {
					return [];
				}
				const initializer = property.getInitializer();
				return initializer ? recur(initializer) : [];
			});
		}
		if (Node.isCallExpression(node)) {
			const callee = node.getExpression();
			const isMap =
				Node.isPropertyAccessExpression(callee) &&
				(callee.getName() === "map" || callee.getName() === "flatMap");
			if (isMap) {
				const callback = node.getArguments()[0];
				return callback ? recur(callback, { repeated: true }) : [];
			}
			// Any call with an inline function argument that contains JSX:
			// `useMemo(() => <div/>, [])`, `useCallback`, `renderWith(() => <X/>)`.
			// `repeated` stays off — only `map`/`flatMap` repeat.
			const fromArguments = node.getArguments().flatMap((argument) => {
				const inline =
					Node.isArrowFunction(argument) || Node.isFunctionExpression(argument);
				return inline && containsJsx(argument) ? recur(argument) : [];
			});
			// `{getCheckinIcon()}` — a local render helper. Inlined where it can be,
			// marked where it cannot: this is the one shape that used to return `[]`
			// with nothing said about it, so four real ids left the tree while
			// `fidelityReason` blamed unrelated external modules.
			const helper = this.renderHelperOf(callee, owner);
			if (!helper) {
				return fromArguments.length > 0
					? fromArguments
					: this.importedRenderHelper(callee, owner);
			}
			const inlined = this.walkRenderHelper(
				helper,
				owner,
				depth,
				path,
				state,
				scope,
			);
			if (inlined.length === 0 && fromArguments.length === 0) {
				return this.marker(owner, node, "local-render-function", rawText(node));
			}
			return [...inlined, ...fromArguments];
		}
		if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
			const body = node.getBody();
			if (Node.isBlock(body)) {
				return body
					.getDescendantsOfKind(SyntaxKind.ReturnStatement)
					.flatMap((statement) => {
						const expression = statement.getExpression();
						return expression ? recur(expression) : [];
					});
			}
			return recur(body);
		}
		if (Node.isIdentifier(node)) {
			return this.walkLocalVariable(
				node.getText(),
				owner,
				depth,
				path,
				state,
				scope,
			);
		}
		return [];
	}

	/**
	 * One hop to a variable declared in the same component body.
	 *
	 * Bounded by {@link MAX_VARIABLE_HOPS}, so the initializer of a resolved
	 * variable cannot resolve another variable, plus a per-walk visited set for
	 * a self-referential initializer. A module-scope or imported constant is
	 * deliberately out of reach: it is outside the component body the caller
	 * owns, and every one of those lands as an `opaque-expression` marker, which
	 * is the point.
	 */
	private walkLocalVariable(
		name: string,
		owner: ComponentDefinition,
		depth: number,
		path: Set<string>,
		state: ExpandState,
		scope: WalkScope,
	): UiNode[] {
		if (scope.varHops <= 0) {
			return [];
		}
		const declaration = this.localVariablesOf(owner).get(name);
		if (!declaration) {
			return [];
		}
		const start = declaration.getStart();
		const visited = scope.visitedVars ?? new Set<number>();
		if (visited.has(start)) {
			return [];
		}
		visited.add(start);
		const initializer = declaration.getInitializer();
		return initializer
			? this.walk(initializer, owner, depth, path, state, {
					varHops: scope.varHops - 1,
					visitedVars: visited,
					position: scope.position,
				})
			: [];
	}

	/**
	 * The same-file function a call expression names, when it returns JSX.
	 *
	 * The call form of the one-hop variable support above: `{icon}` reading
	 * `const icon = <div/>` has always been followed, while `{getIcon()}` reading
	 * `const getIcon = () => <div/>` returned nothing at all. Both are the
	 * caller's own source one identifier away.
	 *
	 * Resolved against this file only, innermost scope first — a helper declared
	 * in the component body shadows a module-scope one of the same name — and
	 * only when its body syntactically contains JSX. That last condition is what
	 * keeps the marker honest: without it every `{t("label")}` between host tags
	 * would look like a render helper the walk failed on.
	 *
	 * Declaration order is not consulted. A function declaration hoists, and a
	 * module-scope `const` is initialised before any component renders; the walk
	 * is not a linter, and refusing a helper written below its use would drop ids
	 * over a rule TypeScript already enforces.
	 */
	private renderHelperOf(
		callee: Node,
		owner: ComponentDefinition,
	): RenderHelper | null {
		if (!Node.isIdentifier(callee)) {
			// `obj.render()` reads a function out of some other object; nothing here
			// can say which, and guessing would attach a subtree to the wrong site.
			return null;
		}
		const name = callee.getText();
		// Innermost binding first, from the call site outward. The index below is
		// per *component* and has no idea where in the body the call is written, so
		// a name declared in an enclosing block was invisible to it: a call inside
		// `if (x) { const renderIcon = ... ; ... renderIcon() }` resolved to the
		// module-scope `renderIcon` and reported that function's subtree, and its
		// ids, at a site that renders something else.
		//
		// `helperIndexOf` handles the function-body level, where a declaration
		// really does shadow every call in the component. This handles the levels
		// below it, which are the ones that depend on position.
		const blockScoped = blockScopedBinding(callee, name, owner.fn);
		if (blockScoped) {
			// Written here and a function: that is the helper, whatever module scope
			// says. Written here and something else: the call is shadowed by a value
			// the walk cannot follow, so it is unknown - and the caller's
			// `local-render-function` marker already reports that honestly.
			const inner = unwrapTransparent(blockScoped);
			return isInlineFunction(inner) && containsJsx(inner)
				? { fn: inner, parameters: parameterNames(inner), nested: true }
				: null;
		}
		const found = this.helperIndexOf(owner).get(name);
		if (!found || !containsJsx(found)) {
			return null;
		}
		return {
			fn: found,
			parameters: parameterNames(found),
			nested: isLexicallyInside(found, owner.fn),
		};
	}

	/**
	 * The marker for a render helper that lives in another file.
	 *
	 * `renderHelperOf` is same-file by construction, so `{renderRow()}` importing
	 * `renderRow` from a sibling module produced no nodes *and* no marker: the ids
	 * it renders were missing from the tree, `fidelity` still read `"full"`,
	 * `traversalGap` returned null on the strength of that, and `idsNotPlaced` was
	 * never even computed. Nothing in the response admitted anything was dropped.
	 *
	 * Not inlined, only reported. The walk attributes every node it makes to
	 * `owner.file`, so pulling a subtree across a module boundary would file those
	 * elements under a file that does not contain them — the fix would be a new
	 * wrong answer in place of a silence.
	 *
	 * The evidence bar is the same as the same-file rule's, which is what keeps
	 * this from marking every `{t("label")}` in the codebase: the name has to
	 * resolve to in-repo source, and that source has to contain JSX. A call into
	 * an installed package resolves external and is left alone — there, nothing
	 * distinguishes a render helper from a formatter.
	 */
	private importedRenderHelper(
		callee: Node,
		owner: ComponentDefinition,
	): UiNode[] {
		if (!Node.isIdentifier(callee)) {
			return [];
		}
		const resolution = resolveComponentRef(
			this.ws,
			this.ws.project,
			owner.sourceFile,
			callee.getText(),
			{ preferSyntacticResolution: true },
		);
		if (resolution.kind !== "local") {
			return [];
		}
		const { fn, sourceFile } = resolution.definition;
		if (sourceFile === owner.sourceFile || !containsJsx(fn)) {
			return [];
		}
		return this.marker(
			owner,
			callee,
			"imported-render-function",
			rawText(callee.getParent() ?? callee),
		);
	}

	/**
	 * Same-file functions that could be render helpers, by name.
	 *
	 * Module scope first, then the component's own body, so an inner declaration
	 * overwrites an outer one of the same name — which is what the language does.
	 * Built once per component definition: the alternative is a file-wide
	 * descendant scan per `{call()}` in the body.
	 */
	private helperIndexOf(owner: ComponentDefinition): Map<string, Node> {
		const key = `${owner.id}${FIELD}${owner.fn.getStart()}`;
		let index = this.helpers.get(key);
		if (index) {
			return index;
		}
		index = new Map<string, Node>();
		for (const declaration of owner.sourceFile.getFunctions()) {
			const name = declaration.getName();
			if (name) {
				index.set(name, declaration);
			}
		}
		for (const declaration of owner.sourceFile.getVariableDeclarations()) {
			const initializer = declaration.getInitializer();
			if (initializer && isInlineFunction(initializer)) {
				index.set(declaration.getName(), unwrapTransparent(initializer));
			}
		}
		for (const declaration of owner.fn.getDescendantsOfKind(
			SyntaxKind.FunctionDeclaration,
		)) {
			const name = declaration.getName();
			if (name && enclosingFunctionOf(declaration) === owner.fn) {
				index.set(name, declaration);
			}
		}
		for (const [name, declaration] of this.localVariablesOf(owner)) {
			const initializer = declaration.getInitializer();
			if (!shadowsWholeBody(declaration, owner.fn)) {
				// Block-scoped, so it decides nothing for the component as a whole -
				// in either direction. A helper declared inside an `if` is the right
				// answer only for calls inside that `if`, which `blockScopedBinding`
				// resolves from the call site; indexing it here handed it to every
				// call in the body, including ones the block does not reach.
				continue;
			}
			if (initializer && isInlineFunction(initializer)) {
				index.set(name, unwrapTransparent(initializer));
			} else {
				// A local that is *not* a function written here still shadows the
				// module-scope one of the same name — `const renderIcon =
				// props.renderIcon ?? fallback` is the caller's function or the
				// module's, and the call site cannot say which. Leaving the module
				// entry in place inlined a subtree this render may never produce,
				// with `fidelity: "full"` over the top.
				index.delete(name);
			}
		}
		// Props shadow module scope outright: a render prop is the caller's
		// function, and no local declaration can share a parameter's name (that is a
		// redeclaration), so anything still indexed under one came from module scope
		// and is the wrong function.
		for (const name of parameterNames(owner.fn)) {
			index.delete(name);
		}
		this.helpers.set(key, index);
		return index;
	}

	/**
	 * Inlines a local render helper's returns at the call site.
	 *
	 * Three things this deliberately does not do.
	 *
	 * **It does not bind the call's arguments.** `renderRow(item)` passes a
	 * value, not a prop, and the prop machinery keys on *names*: a helper
	 * parameter that happens to share a name with one of the component's props
	 * would otherwise resolve `data-testid={id}` to whatever the component's own
	 * call site passed — a wrong id reported as proven, the worst answer
	 * available. So every parameter name is shadowed instead
	 * ({@link shadowParameters}) and an id read out of one comes back dynamic,
	 * which is what the flat inventory says about it too.
	 *
	 * **It does not wrap several returns in a `#branch` node.** The nodes are
	 * inlined into the caller's own child list, where a wrapper would read as
	 * structure the source does not have; they carry `conditional` instead, which
	 * is the fact a selector writer needs.
	 *
	 * **It adds nothing to the expansion memo key.** A helper belongs to the
	 * component body being walked, and what it produces is a function of that
	 * body plus the same {@link ExpandState} the key already covers — the call's
	 * arguments change nothing, precisely because they are not bound.
	 */
	private walkRenderHelper(
		helper: RenderHelper,
		owner: ComponentDefinition,
		depth: number,
		path: Set<string>,
		state: ExpandState,
		scope: WalkScope,
	): UiNode[] {
		// On the builder rather than in `WalkScope`, which is reset to
		// `DEFAULT_SCOPE` at every element boundary: a helper rendering an element
		// that calls the helper again would get a fresh visited set each time and
		// recurse until the stack ran out.
		const key = `${owner.file}${FIELD}${helper.fn.getStart()}`;
		if (helper.fn === owner.fn || this.activeHelpers.has(key)) {
			return [];
		}
		const returns = componentReturnExpressions(
			helper.fn as ComponentDefinition["fn"],
		);
		if (returns.length === 0) {
			return [];
		}
		const childState = helper.nested
			? shadowParameters(state, helper.parameters)
			: detachFromCallSite(state);
		this.activeHelpers.add(key);
		try {
			return returns.flatMap((expression) =>
				this.walk(
					expression,
					owner,
					depth,
					path,
					returns.length > 1
						? { ...childState, conditional: true }
						: childState,
					scope,
				),
			);
		} finally {
			this.activeHelpers.delete(key);
		}
	}

	/**
	 * Variables declared directly in a component's own body, indexed by name.
	 *
	 * Built once per definition: without the index this is a full body scan per
	 * `{identifier}` reference, which shows up immediately on a large component.
	 * The `nearestFunction` predicate is the same one
	 * `componentReturnExpressions` uses, so a variable declared inside a nested
	 * callback does not leak into the component's scope.
	 */
	private localVariablesOf(
		owner: ComponentDefinition,
	): Map<string, VariableDeclaration> {
		const key = `${owner.id}${FIELD}${owner.fn.getStart()}`;
		let index = this.localVariables.get(key);
		if (index) {
			return index;
		}
		index = new Map<string, VariableDeclaration>();
		for (const declaration of owner.fn.getDescendantsOfKind(
			SyntaxKind.VariableDeclaration,
		)) {
			if (enclosingFunctionOf(declaration) !== owner.fn) {
				continue;
			}
			const name = declaration.getNameNode();
			if (Node.isIdentifier(name) && !index.has(name.getText())) {
				index.set(name.getText(), declaration);
			}
		}
		this.localVariables.set(key, index);
		return index;
	}

	/**
	 * Walks a child list, leaving a marker wherever it could see content but not
	 * place it.
	 *
	 * Returning `[]` for an expression the walk did not understand is the failure
	 * this whole change exists to remove: the id is in the source, the agent
	 * cannot see it in the tree, and nothing says so.
	 *
	 * Two rules keep that from turning into noise, and the difference between
	 * them is how much evidence there is that something was lost.
	 *
	 * - JSX the walk could not place is always flagged. The source says
	 *   "elements go here" in as many words.
	 * - An *opaque* expression is only flagged in `position: "content"` — the
	 *   slot and prop positions of a component element, where the caller is
	 *   handing something to a component and a node is what components take.
	 *   Between host tags the same expression is React's text interpolation far
	 *   more often than not: `<span>{item.name}</span>` is a string, and a
	 *   marker on every one of those makes `fidelity: "partial"` the permanent
	 *   answer for reasons nobody can act on.
	 */
	private walkChildren(
		children: Node[],
		owner: ComponentDefinition,
		depth: number,
		path: Set<string>,
		state: ExpandState,
		position: "host" | "content",
	): UiNode[] {
		const out: UiNode[] = [];
		let starved = false;
		for (const child of children) {
			const emittedBefore = this.emitted;
			const walked = this.walk(child, owner, depth, path, state);
			if (walked.length > 0) {
				out.push(...walked);
				continue;
			}
			// The budget ran out mid-child: the loss is real but charging a marker
			// for it is impossible, so one marker stands for the whole child list.
			if (this.emitted === emittedBefore && this.budget.nodeLimitHit) {
				starved = true;
				continue;
			}
			if (containsJsx(child)) {
				out.push(...this.marker(owner, child, "unresolved-jsx"));
			} else if (
				position === "content" &&
				this.isPotentialContent(child, owner)
			) {
				out.push(...this.marker(owner, child, "opaque-expression"));
			}
		}
		// The reserved slot, spent where the walk first ran out: the innermost list
		// unwinds first, so that is the one that stands for the cut.
		if (starved && this.markerSlot === "held") {
			this.markerSlot = "spent";
			out.push(
				this.markerNode(owner, children[0] ?? owner.fn, "node-budget-reached"),
			);
		}
		return out;
	}

	/**
	 * Whether an expression could render UI even though the walk cannot say what.
	 *
	 * Text, literals and empty expressions are excluded outright. So is a bare
	 * identifier the component does not declare: `{count}` reading a prop is
	 * evidence of nothing, while `{b}` naming a `const` in this very body is the
	 * walk admitting it looked at a declaration and could not place what it
	 * found.
	 */
	private isPotentialContent(node: Node, owner: ComponentDefinition): boolean {
		if (Node.isJsxExpression(node)) {
			const expression = node.getExpression();
			return (
				expression !== undefined && this.isPotentialContent(expression, owner)
			);
		}
		if (Node.isParenthesizedExpression(node)) {
			return this.isPotentialContent(node.getExpression(), owner);
		}
		if (Node.isIdentifier(node)) {
			return (
				node.getText() !== "undefined" &&
				this.localVariablesOf(owner).has(node.getText())
			);
		}
		if (
			Node.isPropertyAccessExpression(node) ||
			Node.isElementAccessExpression(node) ||
			Node.isCallExpression(node) ||
			Node.isArrayLiteralExpression(node) ||
			Node.isObjectLiteralExpression(node) ||
			Node.isArrowFunction(node) ||
			Node.isFunctionExpression(node)
		) {
			return true;
		}
		if (Node.isConditionalExpression(node)) {
			return (
				this.isPotentialContent(node.getWhenTrue(), owner) ||
				this.isPotentialContent(node.getWhenFalse(), owner)
			);
		}
		if (Node.isBinaryExpression(node)) {
			return (
				this.isPotentialContent(node.getLeft(), owner) ||
				this.isPotentialContent(node.getRight(), owner)
			);
		}
		return false;
	}

	/** A marker node, budget permitting: a hole nobody can see is not honest either. */
	private marker(
		owner: ComponentDefinition,
		node: Node,
		reason: UiUnresolvedReason,
		raw?: string,
	): UiNode[] {
		if (!this.spendNode()) {
			this.boundaries += 1;
			return [];
		}
		return [this.markerNode(owner, node, reason, raw)];
	}

	private markerNode(
		owner: ComponentDefinition,
		node: Node,
		reason: UiUnresolvedReason,
		raw?: string,
	): UiNode {
		const position = lineAndColumnAt(owner.sourceFile, node.getStart());
		return {
			tag: "#unresolved",
			nodeType: "unresolved",
			file: owner.file,
			loc: {
				file: owner.file,
				line: position.line,
				column: position.column,
			},
			component: owner.name,
			unresolved: raw === undefined ? { reason } : { reason, raw },
			children: [],
		};
	}

	private element(
		opening: Node,
		children: Node[],
		owner: ComponentDefinition,
		depth: number,
		path: Set<string>,
		state: ExpandState,
	): UiNode[] {
		if (
			!Node.isJsxOpeningElement(opening) &&
			!Node.isJsxSelfClosingElement(opening)
		) {
			return [];
		}
		if (!this.spendNode()) {
			this.boundaries += 1;
			return [];
		}

		const scanned = this.scannedAt(owner, opening.getStart());
		const tag = opening.getTagNameNode().getText();
		const position = lineAndColumnAt(owner.sourceFile, opening.getStart());
		const node: UiNode = {
			tag,
			// Same predicate the scan uses, so an id's `reach` and the node it hangs
			// off can never disagree about what the tag is.
			nodeType: isComponentTag(tag) ? "component" : "element",
			file: owner.file,
			loc: {
				file: owner.file,
				line: position.line,
				column: position.column,
			},
			component: owner.name,
			children: [],
		};
		const conditional =
			state.conditional ||
			isConditionallyRendered(opening) ||
			!!scanned?.conditional;
		const repeated = state.repeated || isRepeated(opening);
		if (conditional) {
			node.conditional = true;
		}
		if (repeated) {
			node.repeated = true;
		}

		this.bindTestId(node, scanned, owner, state);

		if (node.nodeType === "element") {
			node.children = this.walkChildren(
				children,
				owner,
				depth,
				path,
				state,
				"host",
			);
			return [node];
		}

		// Content the *caller* wrote and handed to this component. Walked before
		// anything else the component costs, so that when the budget runs low the
		// observed half of the tree outranks the inferred half — and walked
		// whatever the component turns out to be, because the source is the
		// caller's either way.
		const contentChildren = [
			...this.walkPropContent(opening, owner, depth, path, state),
			...this.walkSlotContent(children, owner, depth, path, state),
		];
		const stop = (reason: UiUnresolvedReason): UiNode[] => {
			node.unresolved = { reason };
			node.children = contentChildren;
			return [node];
		};

		// Component: recurse into its definition with the call-site props.
		const resolution = resolveComponentRef(
			this.ws,
			this.ws.project,
			owner.sourceFile,
			tag,
			{ preferSyntacticResolution: true },
		);
		if (resolution.kind === "external") {
			return stop("external-module");
		}
		if (resolution.kind === "unresolved") {
			return stop(resolution.reason);
		}
		node.componentRef = resolution.definition.id;
		// Recursion on the current path stays a `repeated` leaf: this is the
		// component rendering itself, not a second independent render site.
		if (path.has(resolution.definition.id)) {
			this.boundaries += 1;
			node.repeated = true;
			return stop("recursive");
		}

		const childState: ExpandState = {
			bindings: this.callSiteBindings(scanned, resolution.definition),
			provided: this.callSiteProvided(opening, resolution.definition),
			spreadAtSite: !!scanned?.hasSpread,
			callSiteKnown: true,
			directAttribute: scanned?.testIds[0] ?? null,
			conditional,
			repeated,
		};
		const key = expansionKey(resolution.definition.id, childState);

		// Second and later sites of an identical expansion become references.
		// This is checked *before* the depth limit on purpose: emitting a
		// reference expands nothing, so it consumes no depth and no nodes beyond
		// the one already spent on this element. The referenced expansion is
		// known to be complete, so pointing a deep site at it reports strictly
		// more than the `depth-limit-reached` stub it replaces.
		//
		// The site's own content children still ship: they were written here, not
		// there, and dropping them would silently lose the caller's JSX at every
		// site after the first.
		const expandedAt = this.expansions.get(key);
		if (expandedAt) {
			node.expandedAt = expandedAt;
			node.children = contentChildren;
			return [node];
		}

		// A caller choice, not a budget cut: no `boundaries`, no `truncated`.
		if (!this.followComponents) {
			return stop("not-followed");
		}

		if (!this.budget.allowsDepth(depth + 1)) {
			this.boundaries += 1;
			this.noteSite(
				"depth-limit-reached",
				`Depth limit reached at <${tag}>; its subtree was not expanded.`,
				node.loc,
			);
			return stop("depth-limit-reached");
		}

		// Captured after the content walk: a cut inside the caller's own children
		// says nothing about the callee's expansion, which did not depend on them.
		const boundariesBefore = this.boundaries;
		const expansion = this.expandComponent(
			resolution.definition,
			depth + 1,
			path,
			childState,
		);
		if (this.boundaries === boundariesBefore && expansion.length > 0) {
			this.expansions.set(key, node.loc);
		}
		// Expansion first, then passed content: the outline then reads as shell
		// followed by what this site put into it.
		node.children = [...expansion, ...contentChildren];
		return [node];
	}

	/**
	 * JSX the call site passed as an ordinary prop.
	 *
	 * Component tags only. In React a JSX-valued attribute on a *host* element is
	 * stringified rather than rendered, so walking `<div title={<span
	 * data-tid="X"/>}/>` would claim an id renders that never does. The scan
	 * still inventories it, which is the honest direction: the tree may
	 * under-claim, never over-claim.
	 */
	private walkPropContent(
		opening: Node,
		owner: ComponentDefinition,
		depth: number,
		path: Set<string>,
		state: ExpandState,
	): UiNode[] {
		if (
			!Node.isJsxOpeningElement(opening) &&
			!Node.isJsxSelfClosingElement(opening)
		) {
			return [];
		}
		const out: UiNode[] = [];
		for (const attribute of opening.getAttributes()) {
			if (!Node.isJsxAttribute(attribute)) {
				continue;
			}
			const name = attribute.getNameNode().getText();
			if (name === this.attribute) {
				continue;
			}
			const expression = this.jsxValuedAttribute(attribute, owner);
			if (!expression) {
				continue;
			}
			// `children={…}` is the slot spelled as an attribute; React treats the
			// two identically, so the placement must read identically too.
			const placement =
				name === "children"
					? ({ kind: "slot", name: "children" } as const)
					: ({ kind: "prop", name } as const);
			// A render prop is JSX the *callee* decides when, where and how often to
			// produce — `renderItem={(i) => <li/>}` may run once per row or never.
			// Walking its body would report those elements as rendered here, at this
			// position, exactly once. Flag the JSX instead of misplacing it. Judged
			// on what the name resolves to, so passing the very same arrow by name
			// is read the same way.
			const walked = isInlineFunction(this.propContentSource(expression, owner))
				? []
				: this.walk(expression, owner, depth, path, state, {
						varHops: MAX_VARIABLE_HOPS,
						position: "content",
					});
			if (walked.length > 0) {
				out.push(...withPlacement(walked, placement));
				continue;
			}
			out.push(
				...withPlacement(
					this.marker(owner, expression, "unresolved-jsx"),
					placement,
				),
			);
		}
		return out;
	}

	/**
	 * The JSX-bearing expression of an attribute, when it has one.
	 *
	 * "Has one" takes the same single hop to a local variable the slot walk has
	 * always taken: `const footer = <span data-tid="F"/>` handed over as
	 * `footer={footer}` is the caller's own JSX, and testing the identifier for
	 * JSX syntax dropped it — no node, no marker, and a tree that reported
	 * `fidelity: "full"` while omitting an id it could see.
	 */
	private jsxValuedAttribute(
		attribute: JsxAttribute,
		owner: ComponentDefinition,
	): Node | null {
		const initializer = attribute.getInitializer();
		if (!initializer || !Node.isJsxExpression(initializer)) {
			return null;
		}
		const expression = initializer.getExpression();
		if (!expression) {
			return null;
		}
		return containsJsx(this.propContentSource(expression, owner))
			? expression
			: null;
	}

	/**
	 * What a prop's value ultimately names: the expression itself, or the
	 * initializer of the local variable it reads. One hop, the same bound
	 * {@link walkLocalVariable} enforces when it walks the thing.
	 */
	private propContentSource(node: Node, owner: ComponentDefinition): Node {
		const inner = unwrapTransparent(node);
		if (!Node.isIdentifier(inner)) {
			return node;
		}
		const declaration = this.localVariablesOf(owner).get(inner.getText());
		return declaration?.getInitializer() ?? node;
	}

	/** JSX between the component's tags: its children, wherever it renders them. */
	private walkSlotContent(
		children: Node[],
		owner: ComponentDefinition,
		depth: number,
		path: Set<string>,
		state: ExpandState,
	): UiNode[] {
		return withPlacement(
			this.walkChildren(children, owner, depth, path, state, "content"),
			{ kind: "slot", name: "children" },
		);
	}

	/**
	 * Call-site attribute values, keyed by the name the callee's *body* uses.
	 *
	 * `<Card testId="x" />` reaching `function Card({ testId: id })` has to bind
	 * under `id`, or the `data-testid={id}` inside would be reported dynamic even
	 * though its value is right there at the call site.
	 */
	private callSiteBindings(
		scanned: ScannedElement | undefined,
		definition: ComponentDefinition,
	): Map<string, TestIdValue[]> {
		const bindings = new Map<string, TestIdValue[]>();
		if (!scanned) {
			return bindings;
		}
		for (const [name, values] of scanned.attributes) {
			const [first] = values;
			if (first && first.kind !== "dynamic") {
				// Every readable branch, not just the one that sorted first. The gate
				// stays on `first` so nothing that used to bind stops binding.
				bindings.set(
					name,
					values.filter((value) => value.kind !== "dynamic"),
				);
			}
		}
		for (const [local, propName] of definition.propAliases) {
			const value = bindings.get(propName);
			if (value) {
				bindings.set(local, value);
			}
		}
		return bindings;
	}

	/**
	 * Every prop name the call site *wrote*, whatever its value, keyed the same
	 * way as {@link callSiteBindings}.
	 *
	 * Read off the syntax rather than off `ScannedElement.attributes`, which
	 * drops attributes whose value could not be read: `<Btn disabled />` and
	 * `<Btn testId={undefined} />` are absent from that map, and treating them as
	 * unwritten would let the walk claim an attribute renders nothing when the
	 * call site plainly says otherwise.
	 */
	private callSiteProvided(
		opening: Node,
		definition: ComponentDefinition,
	): Set<string> {
		const provided = new Set<string>();
		if (
			!Node.isJsxOpeningElement(opening) &&
			!Node.isJsxSelfClosingElement(opening)
		) {
			return provided;
		}
		for (const attribute of opening.getAttributes()) {
			if (Node.isJsxAttribute(attribute)) {
				provided.add(attribute.getNameNode().getText());
			}
		}
		for (const [local, propName] of definition.propAliases) {
			if (provided.has(propName)) {
				provided.add(local);
			}
		}
		return provided;
	}

	/**
	 * Resolves the element's test id, applying the supported one-hop forwarding
	 * shapes. Everything else is reported as `unresolved` rather than guessed: an
	 * agent trusting a silently-wrong tree is worse off than one told where the
	 * analysis stops.
	 */
	private bindTestId(
		node: UiNode,
		scanned: ScannedElement | undefined,
		owner: ComponentDefinition,
		state: ExpandState,
	): void {
		if (!scanned) {
			return;
		}
		const [value, ...rest] = scanned.testIds;
		if (value && value.kind !== "dynamic") {
			node.testId = value;
			// Every branch of a static choice, not just the one that sorted first:
			// the scan already inventories them all, and a tree that shows one of
			// them contradicts the coverage report built from the same read.
			const alternatives = rest.filter(
				(alternative) => alternative.kind !== "dynamic",
			);
			if (alternatives.length > 0) {
				node.testIdAlternatives = alternatives;
			}
			return;
		}
		if (value && value.kind === "dynamic") {
			const site = this.resolveSiteValue(value, scanned, owner, state);
			if (site.kind === "value") {
				node.testId = site.value;
				// The direct path has always shipped every branch of a static choice.
				// The forwarded path dropped all but the first, so `<Row rowId={big ?
				// "A" : "B"}/>` lost `B` from the tree and from the inventory, and a
				// selector written for it came back dead.
				if (site.alternatives && site.alternatives.length > 0) {
					node.testIdAlternatives = site.alternatives;
				}
				if (site.viaProp) {
					node.viaProp = site.viaProp;
				}
				if (site.viaDefault) {
					node.viaDefault = true;
				}
				return;
			}
			if (site.kind === "absent") {
				// No `testId` at all: writing the prop name here is what put phantom
				// ids like "dataTid" in front of agents as if they were selectors.
				node.testIdAbsent = true;
				return;
			}
			node.testId = value;
			return;
		}
		if (scanned.hasSpread) {
			// The spread has to be carrying *this component's props*, or the caller's
			// attribute never reaches this element. `hasSpread` is true for any
			// spread at all, so `function Save(props) { return <button
			// {...styleProps}/> }` under `<Save data-testid="Save"/>` reported
			// `data-testid="Save"` as rendered on that button — an id nothing in the
			// DOM carries, shipped with `fidelity: "full"` and then matched against a
			// selector as if it had been observed. `spreadNames` and
			// `spreadSourceNames` were both already computed and neither was read.
			const carriesProps = scanned.spreadNames.some((name) =>
				owner.spreadSourceNames.includes(name),
			);
			if (carriesProps && state.directAttribute) {
				node.testId = state.directAttribute;
				node.viaSpread = true;
				return;
			}
			node.unresolved = { reason: "spread-props" };
		}
	}

	/**
	 * What a dynamic test-id expression resolves to *at this render site*.
	 *
	 * The absence rules need positive evidence, all of it: the call site has to
	 * be known, it has to spread nothing (a spread can carry anything), the prop
	 * has to be one this component declares, and it has to be missing from the
	 * attributes the site wrote. Only then is "this attribute renders nothing"
	 * a fact rather than a guess.
	 */
	private resolveSiteValue(
		value: TestIdValue,
		scanned: ScannedElement,
		owner: ComponentDefinition,
		state: ExpandState,
	): SiteValue {
		const reference = propReferenceIn(value.raw, owner);
		if (reference) {
			// The name has to be a prop before anything at the call site can speak
			// for it. Without this the *local* in `const id = makeId()` was looked
			// up in the call-site bindings, so `<Card id="CardRoot"/>` made the tree
			// report `data-testid="CardRoot"` on an element that renders a generated
			// value — and `mergeResolvedOccurrences` then filed the invention as a
			// proven-rendered id. `provablyAbsent` has always demanded this check;
			// the path that *asserts* a value did not, which is the wrong way round.
			if (!declaresProp(reference, owner)) {
				return { kind: "unknown" };
			}
			const bound = state.bindings.get(reference.name);
			const [primary, ...alternatives] = bound ?? [];
			if (primary) {
				return {
					kind: "value",
					value: primary,
					...(alternatives.length > 0 ? { alternatives } : {}),
					viaProp: reference.name,
				};
			}
			if (this.provablyAbsent(reference, owner, state)) {
				const declared = owner.propDefaults.get(reference.name);
				if (declared) {
					// A default the reader cannot name still renders an id. Calling
					// that absent told an agent no selector exists here, which is the
					// one answer the source rules out.
					return declared.kind === "dynamic"
						? { kind: "unknown" }
						: {
								kind: "value",
								value: declared,
								viaProp: reference.name,
								viaDefault: true,
							};
				}
				return { kind: "absent" };
			}
			return { kind: "unknown" };
		}

		// `data-tid={dataTid || "Row"}` and its `??` / ternary spellings.
		const fallback = this.fallbackExpression(scanned, owner);
		if (!fallback) {
			return { kind: "unknown" };
		}
		// Same rule for the operand of `local || "Row"`: only a prop is answerable
		// from the call site.
		if (!declaresProp(fallback.reference, owner)) {
			return { kind: "unknown" };
		}
		const [bound, ...boundRest] =
			state.bindings.get(fallback.reference.name) ?? [];
		if (bound) {
			// The call site passed a readable value, so the operator decides. A
			// ternary decides on its *condition*, and what it renders when the
			// condition holds is a different expression entirely — out of scope.
			if (fallback.form === "ternary") {
				return { kind: "unknown" };
			}
			// A static choice at the call site puts each branch through the operator
			// separately, and an empty one falls back — so the branches can disagree
			// about which value renders. Both readings ship, primary first.
			const resolveOne = (branch: TestIdValue): TestIdValue =>
				fallback.form === "nullish" ||
				branch.kind !== "static" ||
				(branch.value ?? "") !== ""
					? branch
					: fallback.value;
			const primary = resolveOne(bound);
			const alternatives = boundRest
				.map(resolveOne)
				.filter((value) => value !== primary);
			return {
				kind: "value",
				value: primary,
				...(alternatives.length > 0 ? { alternatives } : {}),
				viaProp: fallback.reference.name,
				...(primary === fallback.value ? { viaDefault: true as const } : {}),
			};
		}
		if (this.provablyAbsent(fallback.reference, owner, state)) {
			return {
				kind: "value",
				value: fallback.value,
				viaProp: fallback.reference.name,
				viaDefault: true,
			};
		}
		return { kind: "unknown" };
	}

	/**
	 * `prop || "X"`, `prop ?? "X"` or `prop ? … : "X"` on the test-id attribute,
	 * read back as the prop that was consulted and the static value it falls
	 * back to.
	 */
	private fallbackExpression(
		scanned: ScannedElement,
		owner: ComponentDefinition,
	): {
		reference: PropReference;
		value: TestIdValue;
		form: "or" | "nullish" | "ternary";
	} | null {
		const attribute = scanned.node.getAttribute(this.attribute);
		if (!attribute || !Node.isJsxAttribute(attribute)) {
			return null;
		}
		const initializer = attribute.getInitializer();
		if (!initializer || !Node.isJsxExpression(initializer)) {
			return null;
		}
		let expression = initializer.getExpression();
		while (expression && Node.isParenthesizedExpression(expression)) {
			expression = expression.getExpression();
		}
		if (!expression) {
			return null;
		}
		let tested: PropReference | null = null;
		let fallbackNode: Node | undefined;
		let form: "or" | "nullish" | "ternary" | undefined;
		if (Node.isBinaryExpression(expression)) {
			const operator = expression.getOperatorToken().getKind();
			if (operator === SyntaxKind.BarBarToken) {
				form = "or";
			} else if (operator === SyntaxKind.QuestionQuestionToken) {
				form = "nullish";
			} else {
				return null;
			}
			tested = propReferenceIn(expression.getLeft().getText(), owner);
			fallbackNode = expression.getRight();
		} else if (Node.isConditionalExpression(expression)) {
			form = "ternary";
			tested = propReferenceIn(expression.getCondition().getText(), owner);
			fallbackNode = expression.getWhenFalse();
		}
		if (!tested || !fallbackNode || !form) {
			return null;
		}
		const [value] = readExpressionValue(fallbackNode).values;
		return value && value.kind !== "dynamic"
			? { reference: tested, value, form }
			: null;
	}

	/** The one place absence is judged; every rule has to hold at once. */
	private provablyAbsent(
		reference: PropReference,
		owner: ComponentDefinition,
		state: ExpandState,
	): boolean {
		if (!state.callSiteKnown || state.spreadAtSite) {
			return false;
		}
		if (state.provided.has(reference.name)) {
			return false;
		}
		if (!declaresProp(reference, owner)) {
			return false;
		}
		const written = owner.propAliases.get(reference.name);
		return written === undefined || !state.provided.has(written);
	}
}

/**
 * A prop the test-id expression reads: `testId` or `props.testId`. `container`
 * names the object half of the member form, which is how the walk knows a name
 * is a prop even when the component never destructured it.
 */
interface PropReference {
	name: string;
	container: string | null;
}

/**
 * Whether a name a test-id expression reads is one this component takes as a
 * prop. Anything else is some other binding — a hook result, a module constant,
 * a local — and says nothing at all about what the call site passed.
 *
 * `props.testId` qualifies by construction: `props` *is* the parameter, so every
 * member read off it is a prop whether or not the component destructured it
 * anywhere.
 *
 * Shared by both directions on purpose. Asking it before *denying* an id but not
 * before *asserting* one is exactly backwards: a wrong denial hides a selector,
 * a wrong assertion invents one and the coverage report then treats the
 * invention as proven.
 */
function declaresProp(
	reference: PropReference,
	owner: ComponentDefinition,
): boolean {
	return (
		owner.propNames.includes(reference.name) ||
		owner.propAliases.has(reference.name) ||
		owner.propDefaults.has(reference.name) ||
		(reference.container !== null &&
			owner.spreadSourceNames.includes(reference.container))
	);
}

/** Tags the top level of a passed expression; descendants keep proven placement. */
function withPlacement(
	nodes: UiNode[],
	placement: { kind: "slot" | "prop"; name: string },
): UiNode[] {
	for (const node of nodes) {
		node.placement = placement;
	}
	return nodes;
}

/** A same-file function a call site names, plus the names its parameters bind. */
interface RenderHelper {
	fn: Node;
	parameters: string[];
	/** Declared inside the component body, so it closes over the component's props. */
	nested: boolean;
}

/**
 * Every name a function's parameter list binds, destructuring included.
 *
 * Read off the binding names rather than off the parameter text so that
 * `({ testId, ...rest }: Props)` contributes `testId` and `rest` and not the
 * type annotation.
 */
function parameterNames(fn: Node): string[] {
	if (
		!Node.isArrowFunction(fn) &&
		!Node.isFunctionExpression(fn) &&
		!Node.isFunctionDeclaration(fn)
	) {
		return [];
	}
	const names: string[] = [];
	const collect = (name: Node): void => {
		if (Node.isIdentifier(name)) {
			names.push(name.getText());
			return;
		}
		if (Node.isObjectBindingPattern(name) || Node.isArrayBindingPattern(name)) {
			for (const element of name.getElements()) {
				if (Node.isBindingElement(element)) {
					collect(element.getNameNode());
				}
			}
		}
	};
	for (const parameter of fn.getParameters()) {
		collect(parameter.getNameNode());
	}
	return names;
}

/**
 * The call-site state a render helper's body is walked with.
 *
 * A helper *parameter* is not a prop, and the two live in the same namespace as
 * far as `resolveSiteValue` is concerned. Removing the name from `bindings`
 * stops the component's own call-site value from being read as this
 * parameter's; adding it to `provided` — the evidence of absence — stops
 * `provablyAbsent` from concluding the opposite, that the attribute renders
 * nothing. What is left is the honest answer: unknown, reported dynamic,
 * exactly as the flat inventory reports it.
 */
function shadowParameters(state: ExpandState, names: string[]): ExpandState {
	if (names.length === 0) {
		return state;
	}
	const bindings = new Map(state.bindings);
	const provided = new Set(state.provided);
	for (const name of names) {
		bindings.delete(name);
		provided.add(name);
	}
	return { ...state, bindings, provided };
}

/**
 * The state a helper declared *outside* the component body is walked with.
 *
 * {@link shadowParameters} removes the names a helper's parameters bind, which
 * is the whole story for a helper written inside the component: everything it
 * did not shadow really is the component's own scope. A module-scope function
 * closes over nothing of the kind. Its identifiers resolve to module scope, and
 * walking it with the component's call-site state read them as the component's
 * props anyway — with no parameters to shadow, a zero-argument
 * `function renderRow() { return <div data-testid={rowId}/> }` was handed the
 * caller's `rowId` verbatim and reported it as the id that renders.
 *
 * Clearing `bindings` is half of it; `callSiteKnown: false` is the other half,
 * for the same reason it is false at the root. Without it the empty `provided`
 * set becomes positive evidence of *absence*, and the walk swaps one wrong
 * answer for its mirror image — "no id renders here" asserted from a scope it
 * cannot see. `conditional` and `repeated` are kept: they describe the position
 * the call sits at, which is the caller's fact, not the callee's.
 */
function detachFromCallSite(state: ExpandState): ExpandState {
	return {
		...state,
		bindings: new Map(),
		provided: new Set(),
		spreadAtSite: false,
		callSiteKnown: false,
		directAttribute: null,
	};
}

/**
 * Whether a variable declaration shadows its name across the whole function
 * body, rather than inside one block of it.
 *
 * `const` and `let` are block-scoped: a declaration nested in an `if` or a loop
 * is invisible to the statements around it, so it cannot be what a call written
 * outside that block resolves to. `var` is function-scoped and does shadow the
 * body, which is why the kind is checked rather than assumed.
 */
function shadowsWholeBody(declaration: VariableDeclaration, fn: Node): boolean {
	// The declaration *list*, not the statement: a `for (var i = 0; ...)`
	// initializer is a list with no enclosing statement, so requiring one missed
	// the `var` form entirely - and `var` is exactly the kind that does shadow
	// the whole body.
	const list = declaration.getParent();
	if (
		Node.isVariableDeclarationList(list) &&
		list.getDeclarationKind() === VariableDeclarationKind.Var
	) {
		return true;
	}
	const statement = declaration.getVariableStatement();
	if (!statement) {
		return false;
	}
	const body =
		Node.isFunctionDeclaration(fn) ||
		Node.isFunctionExpression(fn) ||
		Node.isArrowFunction(fn)
			? fn.getBody()
			: undefined;
	return body !== undefined && statement.getParent() === body;
}

/**
 * A declaration of `name` in a block between the call site and the component
 * body, or `null` when the nearest binding is not block-scoped.
 *
 * Only the levels *below* the function body: `helperIndexOf` already owns the
 * body level, where a declaration shadows every call in the component no matter
 * where it is written. Here position is the whole question, so the walk starts
 * at the call and stops at the body.
 *
 * `var` is deliberately not consulted - it is function-scoped, so
 * {@link shadowsWholeBody} has already accounted for it at the body level.
 * Returns the initializer (or the declaration, for a hoisted `function`) so the
 * caller can decide whether it is a helper or an opaque value.
 */
function blockScopedBinding(from: Node, name: string, body: Node): Node | null {
	for (let scope = from.getParent(); scope; scope = scope.getParent()) {
		if (scope === body) {
			return null;
		}
		if (!Node.isBlock(scope) && !Node.isCaseClause(scope)) {
			continue;
		}
		for (const statement of scope.getStatements()) {
			if (Node.isFunctionDeclaration(statement)) {
				if (statement.getName() === name) {
					return statement;
				}
				continue;
			}
			if (!Node.isVariableStatement(statement)) {
				continue;
			}
			const list = statement.getDeclarationList();
			if (list.getDeclarationKind() === VariableDeclarationKind.Var) {
				continue;
			}
			for (const declaration of list.getDeclarations()) {
				const nameNode = declaration.getNameNode();
				if (Node.isIdentifier(nameNode) && nameNode.getText() === name) {
					return declaration.getInitializer() ?? declaration;
				}
			}
		}
	}
	return null;
}

/** Whether `node` is written somewhere inside `container`. */
function isLexicallyInside(node: Node, container: Node): boolean {
	let current: Node | undefined = node.getParent();
	while (current) {
		if (current === container) {
			return true;
		}
		current = current.getParent();
	}
	return false;
}

/** Source text for a marker: one line, bounded, so a long call cannot bloat the payload. */
function rawText(node: Node, limit = 80): string {
	const text = node.getText().replace(/\s+/g, " ").trim();
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Whether an expression is a function written right here.
 *
 * Unwrapped first: `renderItem={((i) => <li/>) as never}` is the same render
 * prop as `renderItem={(i) => <li/>}`, and testing the wrapper reported the
 * `<li>` as UI rendered at this position when the callee decides whether it
 * runs at all.
 */
function isInlineFunction(node: Node): boolean {
	const inner = unwrapTransparent(node);
	return Node.isArrowFunction(inner) || Node.isFunctionExpression(inner);
}

/** Whether an expression syntactically contains JSX anywhere inside it. */
function containsJsx(node: Node): boolean {
	if (isJsxNode(node)) {
		return true;
	}
	return node.getFirstDescendant(isJsxNode) !== undefined;
}

function isJsxNode(node: Node): boolean {
	return (
		Node.isJsxElement(node) ||
		Node.isJsxSelfClosingElement(node) ||
		Node.isJsxFragment(node)
	);
}

/** Nearest enclosing function, mirroring `componentReturnExpressions`. */
function enclosingFunctionOf(node: Node): Node | undefined {
	let current: Node | undefined = node.getParent();
	while (current) {
		if (
			Node.isFunctionDeclaration(current) ||
			Node.isArrowFunction(current) ||
			Node.isFunctionExpression(current) ||
			Node.isMethodDeclaration(current)
		) {
			return current;
		}
		current = current.getParent();
	}
	return undefined;
}

/**
 * `testId` and `props.testId` both bind; anything else is out of scope for v1.
 *
 * The member form only counts when its object half is the component's own props
 * parameter (`props`, or whatever `({ a, ...rest })` named the rest element).
 * Accepting any dotted expression would read `data-testid={item.id}` inside a
 * `.map` as the prop `id` and bind it to whatever a call site passed under that
 * name — a wrong id reported as proven, which is the worst answer available.
 */
function propReferenceIn(
	raw: string,
	owner: ComponentDefinition,
): PropReference | null {
	const trimmed = raw.trim();
	if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
		return { name: trimmed, container: null };
	}
	const member = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(trimmed);
	if (!member) {
		return null;
	}
	const container = member[1];
	// `props` by name as well, for a component that reads `props.x` without ever
	// naming the parameter in a way `readProps` recorded.
	return container === "props" || owner.spreadSourceNames.includes(container)
		? { name: member[2], container }
		: null;
}
