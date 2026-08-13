import { describe, expect, it } from "vitest";
import { staticId } from "../../../analysis";
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
		expect(nodes.map((node) => staticId(node.testId))).toContain("CardBody");
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
		expect(nodes.map((node) => staticId(node.testId))).toContain("InputBody");
	});

	it("enters a component wrapped as `memo(Foo)` by identifier", () => {
		// `memo(Foo)` is as ordinary as `memo(() => ...)`, and unwrapping the call
		// only to find an identifier left it resolving as
		// `not-a-function-component` - the exact gap the unwrap closes, for the
		// spelling that names its component instead of inlining it.
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Badge from "./Badge";',
				"export default function App() { return <Badge />; }",
			].join("\n"),
			"src/Badge.tsx": [
				'import { memo } from "react";',
				'function BadgeBase() { return <span data-testid="BadgeBody" />; }',
				"const Badge = memo(BadgeBase);",
				"export default Badge;",
			].join("\n"),
		});
		expect(nodes.map((node) => staticId(node.testId))).toContain("BadgeBody");
	});

	it("keeps a module helper that a block-scoped local only looks like", () => {
		// `const` is block-scoped, so one declared inside an `if` shadows nothing
		// at a call written outside that block. Deleting the helper entry for it
		// threw away a valid module-scope helper, and the ids it renders, over a
		// name collision the language does not have.
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Panel from "./Panel";',
				"export default function App() { return <Panel />; }",
			].join("\n"),
			"src/Panel.tsx": [
				'function renderTitle() { return <h1 data-testid="PanelTitle" />; }',
				"export default function Panel({ compact }: { compact?: boolean }) {",
				"  if (compact) {",
				"    const renderTitle = 1;",
				"    void renderTitle;",
				"  }",
				"  return <section>{renderTitle()}</section>;",
				"}",
			].join("\n"),
		});
		expect(nodes.map((node) => staticId(node.testId))).toContain("PanelTitle");
	});

	it("does not resolve a call inside a block-local shadow", () => {
		// The other half of the block-scope trade. `helperIndexOf` is per component
		// and has no idea where in the body a call is written, so a call *inside*
		// the block resolved to the module-scope helper and reported its subtree -
		// and its ids - at a site that renders something else.
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Panel from "./Panel";',
				"export default function App() { return <Panel />; }",
			].join("\n"),
			"src/Panel.tsx": [
				'function renderTitle() { return <h1 data-testid="ModuleTitle" />; }',
				"export default function Panel({ compact }: { compact?: boolean }) {",
				"  if (compact) {",
				"    const renderTitle = 1;",
				"    void renderTitle;",
				"    return <section>{renderTitle()}</section>;",
				"  }",
				'  return <aside data-testid="PanelWide" />;',
				"}",
			].join("\n"),
		});
		const ids = nodes.map((node) => staticId(node.testId));
		// The branch that is not shadowed still reports normally.
		expect(ids).toContain("PanelWide");
		// The shadowed call does not borrow the module helper's id.
		expect(ids).not.toContain("ModuleTitle");
	});

	it("uses a block-local helper for a call inside that block", () => {
		// The inverse: a function really declared in the block is the right answer
		// for a call inside it, and the index would never have found it.
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Menu from "./Menu";',
				"export default function App() { return <Menu />; }",
			].join("\n"),
			"src/Menu.tsx": [
				'function renderItem() { return <li data-testid="ModuleItem" />; }',
				"export default function Menu({ compact }: { compact?: boolean }) {",
				"  if (compact) {",
				'    const renderItem = () => <li data-testid="BlockItem" />;',
				"    return <ul>{renderItem()}</ul>;",
				"  }",
				"  return <ul>{renderItem()}</ul>;",
				"}",
			].join("\n"),
		});
		const ids = nodes.map((node) => staticId(node.testId));
		expect(ids).toContain("BlockItem");
		// And the unshadowed call outside the block still gets the module one.
		expect(ids).toContain("ModuleItem");
	});

	it("does not resolve `memo(Inner)` against a shadowed name", () => {
		// The lookup reads the file's top-level declarations, which is only the
		// right answer when the identifier is at top level too. Here `Inner` binds
		// to the parameter, and handing back the module-level function would
		// attribute another component's ids to this site.
		//
		// This passes without the guard as well: reaching the bad path needs a
		// component declaration that is itself nested inside a function *and*
		// resolved through `resolveComponentRef`, which no fixture here produces.
		// Kept as a no-cross-attribution guard, not as proof of the fix.
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Outer from "./Outer";',
				"export default function App() { return <Outer />; }",
			].join("\n"),
			"src/Outer.tsx": [
				'import { memo } from "react";',
				'function Inner() { return <b data-testid="ModuleInner" />; }',
				"function make(Inner: () => unknown) {",
				"  return memo(Inner);",
				"}",
				"export default function Outer() {",
				'  return <div data-testid="OuterBody">{String(make)}</div>;',
				"}",
			].join("\n"),
		});
		expect(nodes.map((node) => staticId(node.testId))).toContain("OuterBody");
		expect(nodes.map((node) => staticId(node.testId))).not.toContain(
			"ModuleInner",
		);
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
