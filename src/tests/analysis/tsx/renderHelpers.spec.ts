import { describe, expect, it } from "vitest";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import type { TestIdTree, UiNode } from "../../../analysis/types";
import { makeWorkspace } from "../helpers/inMemory";

/**
 * Local render helpers — the silent-recall gap.
 *
 * A production component declared `const getCheckinIcon = () => <div
 * data-tid="…"/>` in its own body and called it from JSX. The walk understood
 * neither the call nor its own failure to follow it: four real ids left the
 * tree, the node above them shipped `children: []`, and `fidelityReason` blamed
 * unrelated external modules. The flat inventory had all four the whole time,
 * so nothing but the tree walk was wrong — and nothing said so.
 */

function flatten(nodes: UiNode[]): UiNode[] {
	return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function ids(tree: TestIdTree): string[] {
	return flatten(tree.roots)
		.map((node) => node.testId?.value)
		.filter((value): value is string => value !== undefined)
		.sort();
}

function markers(tree: TestIdTree): UiNode[] {
	return flatten(tree.roots).filter(
		(node) => node.unresolved?.reason === "local-render-function",
	);
}

function treeOf(files: Record<string, string>, entry = "src/Page.tsx") {
	return buildTestIdTree(makeWorkspace(files), { entry });
}

describe("same-file render helpers are inlined", () => {
	it("follows a helper declared above its use", () => {
		const tree = treeOf({
			"src/Page.tsx": [
				"export function Page() {",
				'  const renderIcon = () => <i data-testid="Icon" />;',
				'  return <div data-testid="Root">{renderIcon()}</div>;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["Icon", "Root"]);
		expect(tree.fidelity).toBe("full");
	});

	it("follows a function declaration written below its use", () => {
		const tree = treeOf({
			"src/Page.tsx": [
				"export function Page() {",
				'  return <div data-testid="Root">{renderIcon()}</div>;',
				"}",
				'function renderIcon() { return <i data-testid="Icon" />; }',
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["Icon", "Root"]);
	});

	it("follows a module-scope arrow helper", () => {
		const tree = treeOf({
			"src/Page.tsx": [
				'const renderIcon = () => <i data-testid="Icon" />;',
				"export function Page() {",
				'  return <div data-testid="Root">{renderIcon()}</div>;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["Icon", "Root"]);
	});

	it("prefers the helper declared in the component body over a module-scope one", () => {
		const tree = treeOf({
			"src/Page.tsx": [
				'const renderIcon = () => <i data-testid="Outer" />;',
				"export function Page() {",
				'  const renderIcon = () => <i data-testid="Inner" />;',
				'  return <div data-testid="Root">{renderIcon()}</div>;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["Inner", "Root"]);
	});

	it("keeps both branches of a helper that returns conditionally", () => {
		const tree = treeOf({
			"src/Page.tsx": [
				"export function Page({ checked }: { checked: boolean }) {",
				"  const renderIcon = () => {",
				'    if (checked) { return <i data-testid="On" />; }',
				'    return <i data-testid="Off" />;',
				"  };",
				'  return <div data-testid="Root">{renderIcon()}</div>;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["Off", "On", "Root"]);
		const on = flatten(tree.roots).find((node) => node.testId?.value === "On");
		// Several returns are mutually exclusive: a selector writer has to know only
		// one of them renders.
		expect(on?.conditional).toBe(true);
	});

	it("walks a helper returning a fragment", () => {
		const tree = treeOf({
			"src/Page.tsx": [
				"export function Page() {",
				"  const renderIcons = () => (",
				'    <><i data-testid="First" /><i data-testid="Second" /></>',
				"  );",
				'  return <div data-testid="Root">{renderIcons()}</div>;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["First", "Root", "Second"]);
	});

	it("inlines both helpers of a ternary and marks them conditional", () => {
		// The field shape, in miniature: `{cond ? getA() : getB()}` inside a host
		// element, both helpers declared in the component body.
		const tree = treeOf({
			"src/Page.tsx": [
				"export function Page({ checked }: { checked: boolean }) {",
				'  const getIn = () => <i data-testid="In" />;',
				'  const getOut = () => <i data-testid="Out" />;',
				"  return (",
				'    <div data-testid="Hint">{checked ? getIn() : getOut()}</div>',
				"  );",
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["Hint", "In", "Out"]);
		const hint = flatten(tree.roots).find(
			(node) => node.testId?.value === "Hint",
		);
		expect(hint?.children).toHaveLength(2);
		for (const child of hint?.children ?? []) {
			expect(child.conditional).toBe(true);
		}
	});
});

describe("what a render helper's arguments are not", () => {
	it("walks a helper that takes arguments without binding them", () => {
		const tree = treeOf({
			"src/Page.tsx": [
				"export function Page() {",
				'  const renderRow = (label: string) => <li data-testid="Row">{label}</li>;',
				'  return <ul data-testid="List">{renderRow("a")}</ul>;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["List", "Row"]);
	});

	it("never resolves a helper parameter through the component's own props", () => {
		// `testId` is a prop of `Row` *and* a parameter of its helper. Binding the
		// call site's "FromCaller" onto the helper's parameter would report an id
		// that never renders, as if it were proven.
		const tree = treeOf({
			"src/Page.tsx": [
				'import { Row } from "./Row";',
				"export function Page() {",
				'  return <Row testId="FromCaller" />;',
				"}",
			].join("\n"),
			"src/Row.tsx": [
				"export function Row({ testId }: { testId?: string }) {",
				"  const renderCell = (testId: string) => <td data-testid={testId} />;",
				'  return <tr data-testid={testId}>{renderCell("x")}</tr>;',
				"}",
			].join("\n"),
		});
		const nodes = flatten(tree.roots);
		const cell = nodes.find((node) => node.tag === "td");
		expect(cell).toBeDefined();
		expect(cell?.testId?.kind).toBe("dynamic");
		expect(cell?.testIdAbsent).toBeUndefined();
		// The row's own prop still resolves; only the shadowed name does not.
		expect(nodes.find((node) => node.tag === "tr")?.testId?.value).toBe(
			"FromCaller",
		);
	});
});

describe("what the walk says when it cannot inline", () => {
	it("marks a self-recursive helper instead of dropping it", () => {
		const tree = treeOf({
			"src/Page.tsx": [
				"export function Page({ depth }: { depth: number }) {",
				"  const renderNode = (): JSX.Element =>",
				'    depth > 0 ? <span data-testid="Nested">{renderNode()}</span> : <b data-testid="Leaf" />;',
				'  return <div data-testid="Root">{renderNode()}</div>;',
				"}",
			].join("\n"),
		});
		// One level in, then the cycle is cut and said out loud.
		expect(ids(tree)).toEqual(["Leaf", "Nested", "Root"]);
		const marker = markers(tree)[0];
		expect(marker).toBeDefined();
		expect(marker.unresolved?.raw).toBe("renderNode()");
		expect(tree.fidelity).toBe("partial");
		expect(tree.stats.unresolvedByReason["local-render-function"]).toBe(1);
		expect(tree.fidelityReason).toContain("local-render-function");
	});

	it("marks a mutually recursive pair", () => {
		const tree = treeOf({
			"src/Page.tsx": [
				"export function Page() {",
				'  const a = (): JSX.Element => <i data-testid="A">{b()}</i>;',
				'  const b = (): JSX.Element => <i data-testid="B">{a()}</i>;',
				'  return <div data-testid="Root">{a()}</div>;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["A", "B", "Root"]);
		expect(markers(tree)).toHaveLength(1);
	});

	it("says nothing about an ordinary call that returns no JSX", () => {
		// The noise test. Without the "its body contains JSX" condition every
		// translation call between host tags would look like a failed render helper.
		const tree = treeOf({
			"src/Page.tsx": [
				"const t = (key: string) => key.toUpperCase();",
				"export function Page() {",
				'  return <div data-testid="Root">{t("label")}</div>;',
				"}",
			].join("\n"),
		});
		expect(markers(tree)).toHaveLength(0);
		expect(tree.fidelity).toBe("full");
	});

	it("keeps treating a helper passed by name as a render prop", () => {
		// Referenced, not called: the callee decides when and how often it runs, so
		// its JSX is flagged rather than placed. Unchanged behaviour.
		const tree = treeOf({
			"src/Page.tsx": [
				'import { List } from "@ext/ui";',
				"export function Page() {",
				'  const renderItem = () => <li data-testid="Item" />;',
				'  return <List renderItem={renderItem} data-testid="List" />;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["List"]);
		expect(
			flatten(tree.roots).some(
				(node) => node.unresolved?.reason === "unresolved-jsx",
			),
		).toBe(true);
		expect(markers(tree)).toHaveLength(0);
	});
});

describe("budgets still bound the walk", () => {
	it("charges inlined nodes to maxNodes like any other", () => {
		const files = {
			"src/Page.tsx": [
				"export function Page() {",
				"  const renderIcons = () => (",
				'    <><i data-testid="A" /><i data-testid="B" /><i data-testid="C" /></>',
				"  );",
				'  return <div data-testid="Root">{renderIcons()}</div>;',
				"}",
			].join("\n"),
		};
		const whole = buildTestIdTree(makeWorkspace(files), {
			entry: "src/Page.tsx",
		});
		// The fragment is transparent, so: the root div plus three inlined icons.
		expect(whole.stats.nodes).toBe(4);
		const capped = buildTestIdTree(makeWorkspace(files), {
			entry: "src/Page.tsx",
			maxNodes: 3,
		});
		expect(capped.stats.nodes).toBeLessThanOrEqual(3);
		expect(capped.truncated).toBe(true);
	});
});
