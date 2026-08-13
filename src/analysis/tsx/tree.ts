import type { ComponentInfo, TestIdTree } from "../types";
import type { Workspace } from "../workspace";
import { collectComponents } from "./componentGraph";
import { selectFiles } from "./entry";
import {
	computeTestIdTree,
	DEFAULT_MAX_DEPTH,
	DEFAULT_MAX_NODES,
} from "./treeBuilder";

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

// The three modules this file was split into. Re-exported so the barrel and
// the twenty-six importers of `tsx/tree` keep one path.
export {
	type EntryPathMatch,
	entryFileCandidates,
	matchEntryPath,
} from "./entry";
