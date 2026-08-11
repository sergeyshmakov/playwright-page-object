import { describe, expect, it } from "vitest";
import type { TestIdTreeOptions } from "../../../analysis/tsx/tree";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import type { UiNode } from "../../../analysis/types";
import { makeWorkspace } from "../helpers/inMemory";

/**
 * Content the walk dropped without saying it dropped anything.
 *
 * `fidelity: "partial"` is a working answer: it costs a reader nothing but a
 * second call, and every hint the server gives about widening a walk is keyed
 * off it. `fidelity: "full"` over an incomplete tree costs them the question —
 * they stop looking, and `traversalGap` returns null so nothing prompts them
 * either. These are the three places the walk lost nodes and still reported a
 * complete one.
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

describe("gaps the tree has to admit to", () => {
	it("marks a render helper imported from another file", () => {
		const { tree, nodes } = treeFor({
			"src/App.tsx": [
				'import { renderRow } from "./rows";',
				"export default function App() {",
				"  return <table>{renderRow()}</table>;",
				"}",
			].join("\n"),
			"src/rows.tsx": [
				'export function renderRow() { return <tr data-testid="Row" />; }',
			].join("\n"),
		});
		const marker = nodes.find(
			(node) => node.unresolved?.reason === "imported-render-function",
		);
		expect(marker).toBeDefined();
		expect(marker?.unresolved?.raw).toContain("renderRow()");
		// The point of the marker: the tree stops claiming to be complete.
		expect(tree.fidelity).toBe("partial");
	});

	it("does not mark an ordinary imported call", () => {
		// The same evidence bar the same-file rule uses. A marker on every
		// `{t("label")}` would make `partial` the permanent answer for a reason
		// nobody can act on.
		const { tree, nodes } = treeFor({
			"src/App.tsx": [
				'import { t } from "./i18n";',
				'export default function App() { return <p data-testid="P">{t("hi")}</p>; }',
			].join("\n"),
			"src/i18n.ts": "export const t = (key: string) => key;",
		});
		expect(
			nodes.some(
				(node) => node.unresolved?.reason === "imported-render-function",
			),
		).toBe(false);
		expect(tree.fidelity).toBe("full");
	});

	it("spends the reserved marker when a multi-return component is cut", () => {
		// The branch loop breaks when the budget runs out. It used to break
		// silently, so three branches of nine shipped and the payload read as the
		// complete list of what the component can return.
		const branches = Array.from(
			{ length: 8 },
			(_unused, index) =>
				`  if (step === ${index}) return <div data-testid="S${index}" />;`,
		).join("\n");
		const { tree, nodes } = treeFor(
			{
				"src/App.tsx": [
					"export default function App({ step }: { step: number }) {",
					branches,
					'  return <div data-testid="Last" />;',
					"}",
				].join("\n"),
			},
			{ maxNodes: 3 },
		);
		expect(
			nodes.some((node) => node.unresolved?.reason === "node-budget-reached"),
		).toBe(true);
		expect(tree.truncated).toBe(true);
	});

	it("enters a component wrapped in memo", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Card from "./Card";',
				"export default function App() { return <Card />; }",
			].join("\n"),
			"src/Card.tsx": [
				'import { memo } from "react";',
				'const Card = memo(function Card() { return <div data-testid="CardBody" />; });',
				"export default Card;",
			].join("\n"),
		});
		expect(nodes.map((node) => node.testId?.value)).toContain("CardBody");
	});

	it("enters a component wrapped in memo(forwardRef(...))", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Input from "./Input";',
				"export default function App() { return <Input />; }",
			].join("\n"),
			"src/Input.tsx": [
				'import { forwardRef, memo } from "react";',
				"const Input = memo(",
				"  forwardRef<HTMLInputElement>((props, ref) => (",
				'    <input ref={ref} data-testid="InputBody" />',
				"  )),",
				");",
				"export default Input;",
			].join("\n"),
		});
		expect(nodes.map((node) => node.testId?.value)).toContain("InputBody");
	});

	it("still forwards props through a memo wrapper", () => {
		// `forwardRef`'s callback takes `(props, ref)` and the props reader takes
		// the first parameter, so unwrapping must not disturb the binding path.
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Tag from "./Tag";',
				'export default function App() { return <Tag testId="Passed" />; }',
			].join("\n"),
			"src/Tag.tsx": [
				'import { memo } from "react";',
				"const Tag = memo(({ testId }: { testId: string }) => (",
				"  <span data-testid={testId} />",
				"));",
				"export default Tag;",
			].join("\n"),
		});
		const span = nodes.find((node) => node.tag === "span");
		expect(span?.testId).toMatchObject({ value: "Passed" });
		expect(span?.viaProp).toBe("testId");
	});
});
