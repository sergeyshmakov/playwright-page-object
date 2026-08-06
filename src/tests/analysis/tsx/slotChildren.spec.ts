import { describe, expect, it } from "vitest";
import type { TestIdTreeOptions } from "../../../analysis/tsx/tree";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import type { UiNode } from "../../../analysis/types";
import { makeWorkspace } from "../helpers/inMemory";

/**
 * The 90 %-false-negative regression suite.
 *
 * A composition-heavy app writes `<Gapped><div data-tid="X"/></Gapped>` on
 * nearly every screen. The walk used to stop at `Gapped` — a design-system
 * component it cannot read — and drop `X` with it, even though `X` is the
 * caller's own source sitting right there in the file being analysed. Every
 * test here is a shape that used to vanish.
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

function byTestId(nodes: UiNode[], id: string): UiNode | undefined {
	return nodes.find((node) => node.testId?.value === id);
}

function markers(nodes: UiNode[]): UiNode[] {
	return nodes.filter((node) => node.nodeType === "unresolved");
}

/** An app file wrapping `body` in the standard default-export component. */
function app(imports: string[], body: string): string {
	return [
		...imports,
		"export default function App() {",
		`  return ${body};`,
		"}",
	].join("\n");
}

describe("children passed to a component the walk cannot expand", () => {
	it("keeps the host children of an external wrapper", () => {
		const { nodes } = treeFor({
			"src/App.tsx": app(
				['import { Gapped } from "@ext/ui";'],
				'(<Gapped><div data-testid="Inner" /></Gapped>)',
			),
		});

		const gapped = nodes.find((node) => node.tag === "Gapped");
		expect(gapped?.unresolved).toEqual({ reason: "external-module" });
		expect(gapped?.children).toHaveLength(1);
		const inner = gapped?.children[0];
		expect(inner?.testId).toMatchObject({ value: "Inner" });
		expect(inner?.placement).toEqual({ kind: "slot", name: "children" });
	});

	it("puts a local wrapper's own subtree first and the passed content after", () => {
		const { nodes } = treeFor({
			"src/App.tsx": app(
				['import Layout from "./Layout";'],
				'(<Layout><div data-testid="Body" /></Layout>)',
			),
			"src/Layout.tsx": [
				"export default function Layout({ children }: { children?: unknown }) {",
				'  return <main data-testid="Head">{children as never}</main>;',
				"}",
			].join("\n"),
		});

		const layout = nodes.find((node) => node.tag === "Layout");
		expect(layout?.children.map((child) => child.testId?.value)).toEqual([
			"Head",
			"Body",
		]);
		expect(layout?.children[0].placement).toBeUndefined();
		expect(layout?.children[1].placement).toEqual({
			kind: "slot",
			name: "children",
		});
	});

	it("reaches through nested slots and marks only the top of each", () => {
		const { nodes } = treeFor({
			"src/App.tsx": app(
				['import { A, B } from "@ext/ui";'],
				'(<A><B><span data-testid="Deep"><i data-testid="Deeper" /></span></B></A>)',
			),
		});

		const b = nodes.find((node) => node.tag === "B");
		expect(b?.placement).toEqual({ kind: "slot", name: "children" });
		const deep = byTestId(nodes, "Deep");
		expect(deep).toBeDefined();
		expect(b?.children[0]).toBe(deep);
		expect(deep?.placement).toEqual({ kind: "slot", name: "children" });
		// Placement is about *this* node's position under its parent. Below the
		// top of the passed expression the source shows exactly where things go.
		expect(byTestId(nodes, "Deeper")?.placement).toBeUndefined();
	});

	it("walks JSX passed as an ordinary prop", () => {
		const { nodes } = treeFor({
			"src/App.tsx": app(
				['import { Modal } from "@ext/ui";'],
				'<Modal caption={<span data-testid="Cap" />} />',
			),
		});

		expect(byTestId(nodes, "Cap")?.placement).toEqual({
			kind: "prop",
			name: "caption",
		});
	});

	it("normalizes a `children={…}` attribute to a slot", () => {
		const { nodes } = treeFor({
			"src/App.tsx": app(
				['import { Modal } from "@ext/ui";'],
				'<Modal children={<span data-testid="C" />} />',
			),
		});

		expect(byTestId(nodes, "C")?.placement).toEqual({
			kind: "slot",
			name: "children",
		});
	});

	it("walks JSX inside an object literal in a prop", () => {
		const { nodes } = treeFor({
			"src/App.tsx": app(
				['import { Trans } from "@ext/i18n";'],
				'<Trans reactParams={{ Name: <span data-testid="N" /> }} />',
			),
		});

		expect(byTestId(nodes, "N")?.placement).toEqual({
			kind: "prop",
			name: "reactParams",
		});
	});

	it("walks every element of an array-valued prop", () => {
		const { nodes } = treeFor({
			"src/App.tsx": app(
				['import { Tabs, Tab } from "@ext/ui";'],
				'<Tabs items={[<Tab data-testid="T1" />, <Tab data-testid="T2" />]} />',
			),
		});

		for (const id of ["T1", "T2"]) {
			expect(byTestId(nodes, id)?.placement).toEqual({
				kind: "prop",
				name: "items",
			});
		}
	});

	it("resolves one hop through a useMemo variable", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import { useMemo } from "react";',
				'import { Gapped } from "@ext/ui";',
				"export default function App() {",
				'  const info = useMemo(() => <div data-testid="Memo" />, []);',
				"  return <Gapped>{info}</Gapped>;",
				"}",
			].join("\n"),
		});

		expect(byTestId(nodes, "Memo")?.placement).toEqual({
			kind: "slot",
			name: "children",
		});
	});

	it("resolves one hop through a plain local variable with no placement doubt", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				"export default function App() {",
				'  const row = <div data-testid="Row" />;',
				"  return <section>{row}</section>;",
				"}",
			].join("\n"),
		});

		const row = byTestId(nodes, "Row");
		expect(row).toBeDefined();
		// A host element renders its children where the source shows them, so
		// there is nothing unproven about this one.
		expect(row?.placement).toBeUndefined();
	});

	it("stops at the second variable hop and says so", () => {
		const { tree, nodes } = treeFor({
			"src/App.tsx": [
				'import { Gapped } from "@ext/ui";',
				"export default function App() {",
				'  const a = <div data-testid="Z" />;',
				"  const b = a;",
				"  return <Gapped>{b}</Gapped>;",
				"}",
			].join("\n"),
		});

		expect(markers(nodes).map((node) => node.unresolved?.reason)).toContain(
			"opaque-expression",
		);
		expect(byTestId(nodes, "Z")).toBeUndefined();
		// The flat inventory never lost it, which is what keeps coverage honest.
		expect(tree.inventory.some((entry) => entry.value.value === "Z")).toBe(
			true,
		);
	});

	it("flags a render prop instead of pretending to know where it renders", () => {
		const { tree, nodes } = treeFor({
			"src/App.tsx": app(
				['import { List } from "@ext/ui";'],
				'<List renderItem={(i: number) => <li data-testid="Item" />} />',
			),
		});

		// The callee decides when, where and how many times to call it. Walking
		// the body would report `Item` as rendered once, right here.
		expect(byTestId(nodes, "Item")).toBeUndefined();
		const marker = markers(nodes)[0];
		expect(marker?.unresolved).toEqual({ reason: "unresolved-jsx" });
		expect(marker?.placement).toEqual({ kind: "prop", name: "renderItem" });
		expect(tree.inventory.some((entry) => entry.value.value === "Item")).toBe(
			true,
		);
	});

	it("flags an unwalkable call in a component's children", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import { Modal } from "@ext/ui";',
				"declare function renderFooter(): unknown;",
				"export default function App() {",
				"  return <Modal>{renderFooter()}</Modal>;",
				"}",
			].join("\n"),
		});

		expect(markers(nodes).map((node) => node.unresolved?.reason)).toEqual([
			"opaque-expression",
		]);
	});

	it("produces no markers for inert children", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import { Modal } from "@ext/ui";',
				"export default function App({ count }: { count: number }) {",
				"  return (",
				"    <Modal>",
				"      Hello {count}",
				"      {/* a note */}",
				"    </Modal>",
				"  );",
				"}",
			].join("\n"),
		});

		expect(markers(nodes)).toEqual([]);
	});

	it("does not walk a JSX-valued prop on a host element", () => {
		const { tree, nodes } = treeFor({
			"src/App.tsx": app(
				[],
				'<div title={<span data-testid="Ghost" /> as never} />',
			),
		});

		// React stringifies it; claiming the id renders would be an over-claim,
		// and the tree is allowed to under-claim but never to over-claim.
		expect(byTestId(nodes, "Ghost")).toBeUndefined();
		expect(tree.inventory.some((entry) => entry.value.value === "Ghost")).toBe(
			true,
		);
	});

	it("gives a slot child the caller's conditional context", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import { Gapped } from "@ext/ui";',
				"export default function App({ show }: { show: boolean }) {",
				'  return <div>{show && <Gapped><div data-testid="C" /></Gapped>}</div>;',
				"}",
			].join("\n"),
		});

		const c = byTestId(nodes, "C");
		expect(c?.conditional).toBe(true);
		expect(c?.placement).toEqual({ kind: "slot", name: "children" });
	});
});
