import { describe, expect, it } from "vitest";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import type { UiNode } from "../../../analysis/types";
import { makeWorkspace } from "../helpers/inMemory";

/**
 * One element, several ids.
 *
 * `data-testid={big ? "Main" : "Alt"}` — spelled at the top of the attribute or
 * inside a template — renders exactly one id per render, and which one is a
 * runtime choice. The scan has always inventoried every branch. The tree kept
 * the first and dropped the rest, so the two halves of one answer disagreed:
 * `map_coverage` matched a selector for the second branch and `get_testid_tree`
 * showed no element carrying it.
 */

const BOOTSTRAP = {
	"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
};

function flatten(nodes: UiNode[]): UiNode[] {
	return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function treeFor(files: Record<string, string>) {
	const tree = buildTestIdTree(makeWorkspace({ ...BOOTSTRAP, ...files }));
	return { tree, nodes: flatten(tree.roots) };
}

/** Every id the tree reports for one node, primary branch first. */
function idsOf(node: UiNode | undefined): Array<string | undefined> {
	return [
		node?.testId?.value,
		...(node?.testIdAlternatives ?? []).map((value) => value.value),
	];
}

describe("an element whose test id is a static choice", () => {
	it("keeps every branch of a ternary written on the attribute", () => {
		const { nodes, tree } = treeFor({
			"src/App.tsx": [
				"export default function App({ big }: { big: boolean }) {",
				'  return <div data-testid={big ? "Main" : "Alt"} />;',
				"}",
			].join("\n"),
		});

		const div = nodes.find((node) => node.tag === "div");
		expect(idsOf(div)).toEqual(["Main", "Alt"]);
		expect(div?.conditional).toBe(true);
		// The tree now says exactly what the inventory says.
		expect(tree.inventory.map((entry) => entry.value.value).sort()).toEqual([
			"Alt",
			"Main",
		]);
	});

	it("keeps every branch of a ternary interpolated into a template", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				"export default function App({ big }: { big: boolean }) {",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source for the parser, not an interpolation
				'  return <li data-testid={`${big ? "Main" : "Alt"}Row`} />;',
				"}",
			].join("\n"),
		});

		expect(idsOf(nodes.find((node) => node.tag === "li"))).toEqual([
			"MainRow",
			"AltRow",
		]);
	});

	it("leaves a single-valued attribute with no alternatives at all", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				"export default function App() {",
				'  return <div data-testid="Only" />;',
				"}",
			].join("\n"),
		});

		const div = nodes.find((node) => node.tag === "div");
		expect(div?.testId).toMatchObject({ value: "Only" });
		expect(div?.testIdAlternatives).toBeUndefined();
	});
});
