import { describe, expect, it } from "vitest";
import { staticId } from "../../../analysis";
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
		.map((node) => staticId(node.testId))
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
		const on = flatten(tree.roots).find(
			(node) => staticId(node.testId) === "On",
		);
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
			(node) => staticId(node.testId) === "Hint",
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
		expect(staticId(nodes.find((node) => node.tag === "tr")?.testId)).toBe(
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

/**
 * Which enclosing binding the call actually refers to.
 *
 * `blockScopedBinding` exists because a name declared between the call and the
 * component body decides what the call means, and resolving it against the
 * module-scope helper of the same name reports one function's subtree — and its
 * ids — at a site that renders something else. Two spellings were missing from
 * that walk.
 */
describe("bindings between the call and the body", () => {
	it("inlines a `function` declared inside a block", () => {
		// `blockScopedBinding` goes to the trouble of returning a
		// FunctionDeclaration and the caller then required an arrow or a function
		// *expression*, so these ids left the tree over the spelling alone.
		const tree = treeOf({
			"src/Page.tsx": [
				"export function Page({ on }: { on: boolean }) {",
				"  if (on) {",
				"    function renderBadge() {",
				'      return <span data-testid="Badge" />;',
				"    }",
				"    return <div>{renderBadge()}</div>;",
				"  }",
				'  return <div data-testid="Off" />;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toContain("Badge");
	});

	it("does not attribute a `for` loop variable to a module helper", () => {
		// The binding is on the statement header, which is not a Block, so the
		// walk fell through to `helperIndexOf` and reported ModuleRow's subtree at
		// a site that renders whatever the loop variable holds.
		const tree = treeOf({
			"src/Page.tsx": [
				"function renderRow() {",
				'  return <span data-testid="ModuleRow" />;',
				"}",
				"export function Page({ rows }: { rows: (() => never)[] }) {",
				"  for (const renderRow of rows) {",
				'    return <div data-testid="Host">{renderRow()}</div>;',
				"  }",
				'  return <div data-testid="Empty" />;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toContain("Host");
		expect(ids(tree), "the module helper renders somewhere else").not.toContain(
			"ModuleRow",
		);
	});

	it("does not attribute a `catch` parameter to a module helper", () => {
		const tree = treeOf({
			"src/Page.tsx": [
				"function renderError() {",
				'  return <span data-testid="ModuleError" />;',
				"}",
				"export function Page({ run }: { run: () => void }) {",
				"  try {",
				"    run();",
				"  } catch (renderError: never) {",
				'    return <div data-testid="Caught">{renderError()}</div>;',
				"  }",
				'  return <div data-testid="Ok" />;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).not.toContain("ModuleError");
	});

	it("still reaches the module helper when nothing shadows it", () => {
		const tree = treeOf({
			"src/Page.tsx": [
				"function renderRow() {",
				'  return <span data-testid="ModuleRow" />;',
				"}",
				"export function Page() {",
				"  return <div>{renderRow()}</div>;",
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toContain("ModuleRow");
	});
});

describe("bindings the shadowing walk used to spell past", () => {
	it("does not attribute a destructured loop binding to a module helper", () => {
		// `const { renderRow }` binds the name every bit as much as `const
		// renderRow` does, and the walk tested only for an identifier.
		const tree = treeOf({
			"src/Page.tsx": [
				"function renderRow() {",
				'  return <span data-testid="ModuleRow" />;',
				"}",
				"export function Page({ rows }: { rows: { renderRow: () => never }[] }) {",
				"  for (const { renderRow } of rows) {",
				'    return <div data-testid="Host">{renderRow()}</div>;',
				"  }",
				'  return <div data-testid="Empty" />;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).not.toContain("ModuleRow");
	});

	it("does not attribute a destructured block binding to a module helper", () => {
		// The block-level walk had the same blind spot, which nobody reported.
		const tree = treeOf({
			"src/Page.tsx": [
				"function renderRow() {",
				'  return <span data-testid="ModuleRow" />;',
				"}",
				"export function Page({ on, bag }: { on: boolean; bag: { renderRow: () => never } }) {",
				"  if (on) {",
				"    const { renderRow } = bag;",
				'    return <div data-testid="Host">{renderRow()}</div>;',
				"  }",
				'  return <div data-testid="Empty" />;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).not.toContain("ModuleRow");
	});

	it("inlines a function-valued classic `for` initializer", () => {
		// `for (let render = () => <b/>; …)` really does declare a helper, and
		// returning the declaration rather than its initializer lost it.
		const tree = treeOf({
			"src/Page.tsx": [
				"export function Page() {",
				'  for (let renderBadge = () => <span data-testid="Badge" />; ; ) {',
				'    return <div data-testid="Host">{renderBadge()}</div>;',
				"  }",
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toContain("Badge");
	});
});

describe("a JSX local is bound where it is referenced", () => {
	// The body-level index holds one declaration per name for the whole
	// component, so two blocks legally shadowing the same local both expanded
	// from whichever was written first: the tree placed `A` in the branch that
	// renders `B` and recommended a test id that never appears there.
	it("expands each block's own binding, not the first one in the file", () => {
		const tree = treeOf({
			"src/Page.tsx": [
				'const A = () => <div data-testid="FromA" />;',
				'const B = () => <div data-testid="FromB" />;',
				"export function Page({ flag }) {",
				"  if (flag) { const content = <A />; return content; }",
				"  { const content = <B />; return content; }",
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["FromA", "FromB"]);
	});

	// The body level still belongs to the index: a declaration there shadows
	// every reference in the component, wherever it is written.
	it("still resolves a body-level local from inside a block", () => {
		const tree = treeOf({
			"src/Page.tsx": [
				"export function Page({ flag }) {",
				'  const content = <div data-testid="Body" />;',
				"  if (flag) { return content; }",
				"  return content;",
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toContain("Body");
	});
});

describe("a component declared inside another component", () => {
	// `Empty` is a fully static binding, but it is not a declaration *of the
	// file*, so a resolver that starts from the file called it
	// `identifier-unresolved` and the walk stopped at a boundary that is not
	// one — dropping every id the nested component renders.
	it("expands a nested function component", () => {
		const tree = treeOf({
			"src/Page.tsx": [
				"export function Page() {",
				'  function Empty() { return <div data-testid="Empty" />; }',
				'  return <div data-testid="Root"><Empty /></div>;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["Empty", "Root"]);
	});

	it("expands a nested arrow component", () => {
		const tree = treeOf({
			"src/Page.tsx": [
				"export function Page() {",
				'  const Empty = () => <div data-testid="Empty" />;',
				'  return <div data-testid="Root"><Empty /></div>;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["Empty", "Root"]);
	});

	// The nearer declaration wins, which is what the language does.
	it("prefers the nested declaration over a module-level one", () => {
		const tree = treeOf({
			"src/Page.tsx": [
				'const Row = () => <div data-testid="ModuleRow" />;',
				"export function Page() {",
				'  const Row = () => <div data-testid="NestedRow" />;',
				"  return <div><Row /></div>;",
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["NestedRow"]);
	});
});
