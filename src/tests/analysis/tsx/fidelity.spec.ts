import { describe, expect, it } from "vitest";
import type { TestIdTreeOptions } from "../../../analysis/tsx/tree";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import type { UiNode } from "../../../analysis/types";
import { makeWorkspace } from "../helpers/inMemory";

/**
 * `fidelity` describes the completeness of the node tree, not the resolvability
 * of individual test ids.
 *
 * The failure this three-state enum exists for: a tree with zero ids in it
 * reported `fidelity: "full"`, and an agent that reads "full" stops looking. A
 * number next to the word would not have helped — "full" was the claim, and the
 * claim was false.
 */

const BOOTSTRAP = {
	"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
};

function flatten(nodes: UiNode[]): UiNode[] {
	return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function treeFor(files: Record<string, string>, options?: TestIdTreeOptions) {
	const tree = buildTestIdTree(
		makeWorkspace({ ...BOOTSTRAP, ...files }),
		options,
	);
	return { tree, nodes: flatten(tree.roots) };
}

const CHAIN = {
	"src/App.tsx": [
		'import Middle from "./Middle";',
		'export default function App() { return <div data-testid="Shell"><Middle /></div>; }',
	].join("\n"),
	"src/Middle.tsx": [
		'import Leaf from "./Leaf";',
		'export default function Middle() { return <section data-testid="Mid"><Leaf /></section>; }',
	].join("\n"),
	"src/Leaf.tsx":
		'export default function Leaf() { return <b data-testid="Leaf" />; }',
};

describe("tree fidelity", () => {
	it("is full when the walk reached everything", () => {
		const { tree } = treeFor(CHAIN);
		expect(tree.fidelity).toBe("full");
		expect(tree.fidelityReason).toBeUndefined();
		expect(tree.stats.unresolved).toBe(0);
		expect(tree.stats.unresolvedByReason).toEqual({});
		expect(tree.warnings.map((diag) => diag.code)).not.toContain(
			"tree-partial",
		);
	});

	it("is partial as soon as one component cannot be expanded", () => {
		const { tree } = treeFor({
			"src/App.tsx": [
				'import { Gapped } from "@ext/ui";',
				"export default function App() { return <Gapped />; }",
			].join("\n"),
		});
		expect(tree.fidelity).toBe("partial");
		expect(tree.fidelityReason).toBeTruthy();
		expect(tree.fidelityReason).toContain("external-module");
		expect(tree.stats.unresolvedByReason["external-module"]).toBe(1);
		expect(tree.warnings.map((diag) => diag.code)).toContain("tree-partial");
	});

	it("never claims full over a tree that reported no ids at all", () => {
		const { tree } = treeFor({
			"src/App.tsx": [
				'import { Gapped } from "@ext/ui";',
				"export default function App() { return <Gapped />; }",
			].join("\n"),
			"src/Other.tsx": 'export const Other = () => <div data-testid="Some" />;',
		});
		// The literal shape from the field: an empty-looking tree next to a
		// non-empty inventory.
		expect(flatten(tree.roots).some((node) => node.testId)).toBe(false);
		expect(tree.inventory.length).toBeGreaterThan(0);
		expect(tree.fidelity).not.toBe("full");
	});

	it("stays flat with a reason when no entry can be found", () => {
		const tree = buildTestIdTree(
			makeWorkspace({
				"src/Orphan.tsx":
					'export const Orphan = () => <div data-testid="O" />;',
			}),
		);
		expect(tree.fidelity).toBe("flat");
		expect(tree.fidelityReason).toBeTruthy();
		expect(tree.stats.nodes).toBe(0);
	});

	it("keeps full over a spread-props value hole", () => {
		const { tree, nodes } = treeFor({
			"src/App.tsx": [
				'import Btn from "./Btn";',
				"export default function App() { return <Btn />; }",
			].join("\n"),
			"src/Btn.tsx": [
				"export default function Btn(props: Record<string, unknown>) {",
				"  return <button {...props} />;",
				"}",
			].join("\n"),
		});
		// The value is unknown; the node and all its children are right there. A
		// value hole is not a structural hole, and treating it as one would make
		// almost every real repository permanently partial.
		expect(nodes.find((node) => node.tag === "button")?.unresolved).toEqual({
			reason: "spread-props",
		});
		expect(tree.fidelity).toBe("full");
		expect(tree.stats.unresolved).toBe(0);
	});

	it("separates a caller's followComponents: false from a budget cut", () => {
		const { tree, nodes } = treeFor(CHAIN, { followComponents: false });

		const middle = nodes.find((node) => node.tag === "Middle");
		expect(middle?.unresolved).toEqual({ reason: "not-followed" });
		// Not a budget: the caller asked for one level, so nothing was truncated
		// and nothing hit the depth limit.
		expect(tree.truncated).toBeUndefined();
		expect(tree.fidelity).toBe("partial");
		expect(
			tree.stats.unresolvedByReason["depth-limit-reached"],
		).toBeUndefined();
		expect(tree.stats.unresolvedByReason["not-followed"]).toBe(1);
		expect(tree.warnings.map((diag) => diag.code)).toContain(
			"components-not-followed",
		);
	});

	it("still reports a genuine depth cut as truncated", () => {
		const { tree, nodes } = treeFor(CHAIN, { maxDepth: 1 });
		expect(nodes.find((node) => node.tag === "Middle")?.unresolved).toEqual({
			reason: "depth-limit-reached",
		});
		expect(tree.truncated).toBe(true);
		expect(tree.fidelity).toBe("partial");
		expect(tree.stats.unresolvedByReason["depth-limit-reached"]).toBe(1);
	});

	it("states the gap when the walk left the caller's scope", () => {
		// The walk follows imports; the inventory follows the scope. When they
		// disagree, ids land in `roots` and not in `inventory`, and coverage —
		// which reads only the inventory — calls every selector for them dead.
		// Silence about that is the same wrong answer as reporting it wrongly.
		const { tree, nodes } = treeFor(CHAIN, {
			entry: "src/App.tsx",
			include: ["src/App.tsx"],
		});

		expect(nodes.some((node) => node.testId?.value === "Mid")).toBe(true);
		expect(tree.inventory.map((entry) => entry.value.value)).toEqual(["Shell"]);
		const gap = tree.warnings.find(
			(diag) => diag.code === "inventory-scope-gap",
		);
		expect(gap?.message).toContain("src/Middle.tsx");
	});

	// `maxNodes` is a cap on the payload, not only on the walk. Each unwinding
	// child list used to append a `node-budget-reached` marker that nothing had
	// charged for, so a deep nest returned twice the cap it was given.
	it("never returns more nodes than maxNodes allows", () => {
		let body = '<span data-testid="Leaf" />';
		for (let level = 0; level < 12; level += 1) {
			body = `<div data-testid="D${level}">${body}<em data-testid="S${level}" /></div>`;
		}
		const { tree, nodes } = treeFor(
			{
				"src/App.tsx": [
					"export default function App() {",
					`  return ${body};`,
					"}",
				].join("\n"),
			},
			{ maxNodes: 5 },
		);

		expect(nodes.length).toBeLessThanOrEqual(5);
		expect(tree.stats.nodes).toBe(nodes.length);
		expect(tree.truncated).toBe(true);
		// The cut is still reported — once, where the walk ran out.
		expect(tree.stats.unresolvedByReason["node-budget-reached"]).toBe(1);
	});

	it("counts stats over exactly the nodes it emitted", () => {
		const { tree, nodes } = treeFor({
			"src/App.tsx": [
				'import { Gapped } from "@ext/ui";',
				'export default function App() { return <Gapped><i data-testid="In" /></Gapped>; }',
			].join("\n"),
		});
		expect(tree.stats.nodes).toBe(nodes.length);
		expect(tree.stats.slots).toBe(
			nodes.filter((node) => node.placement).length,
		);
		expect(tree.stats.unresolved).toBe(
			nodes.filter(
				(node) => node.unresolved && node.unresolved.reason !== "spread-props",
			).length,
		);
	});
});
