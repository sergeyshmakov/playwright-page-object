import { describe, expect, it } from "vitest";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import type { UiNode } from "../../../analysis/types";
import { makeWorkspace } from "../helpers/inMemory";

/**
 * The one failure mode this analysis must not have: reporting a test id that
 * nothing renders.
 *
 * An id the walk cannot resolve is reported dynamic, and the payload says so —
 * a reader loses a selector and knows it. An id the walk *invents* is reported
 * exactly like one it observed, and it does not stop at the tree:
 * `mergeResolvedOccurrences` drops the honest `dynamic` placeholder and files
 * the invented value under `reach: "forwarded"`, which `mapCoverage` counts as
 * matchable. So the coverage report confirms a selector that will time out, the
 * record that anything was ever unknown is gone, and `fidelity` still reads
 * `"full"`.
 *
 * Every case here is a shape that produced one. They assert an *absence* — the
 * fabricated value is not anywhere in the tree — because the right answer is
 * "unknown", and there is more than one honest way to spell that.
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

/** Every static id the tree claims renders, alternatives included. */
function claimedIds(nodes: UiNode[]): string[] {
	const ids: string[] = [];
	for (const node of nodes) {
		for (const value of [node.testId, ...(node.testIdAlternatives ?? [])]) {
			if (value && value.kind === "static" && value.value) {
				ids.push(value.value);
			}
		}
	}
	return ids;
}

describe("ids the walk must not invent", () => {
	it("does not read a local through a call-site prop of the same name", () => {
		// `id` inside Card is a generated value, not the prop the caller wrote.
		// Binding the call site's `id` to it reported `data-testid="CardRoot"` on
		// an element whose attribute is whatever `makeId()` returns.
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Card from "./Card";',
				'export default function App() { return <Card id="CardRoot" />; }',
			].join("\n"),
			"src/Card.tsx": [
				'import { makeId } from "./ids";',
				"export default function Card({ title }: { title?: string }) {",
				"  const id = makeId();",
				"  return <div data-testid={id}>{title}</div>;",
				"}",
			].join("\n"),
			"src/ids.ts": "export const makeId = () => String(Math.random());",
		});
		expect(claimedIds(nodes)).not.toContain("CardRoot");
	});

	it('does not resolve a local through the `local || "X"` fallback either', () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Row from "./Row";',
				'export default function App() { return <Row slug="FromCaller" />; }',
			].join("\n"),
			"src/Row.tsx": [
				'import { slugOf } from "./slug";',
				"export default function Row({ label }: { label?: string }) {",
				"  const slug = slugOf(label);",
				'  return <div data-testid={slug || "RowFallback"} />;',
				"}",
			].join("\n"),
			"src/slug.ts": "export const slugOf = (s?: string) => s ?? '';",
		});
		// Neither the caller's value nor the fallback: which one renders depends on
		// a local the walk cannot evaluate, so it knows neither.
		expect(claimedIds(nodes)).not.toContain("FromCaller");
		expect(claimedIds(nodes)).not.toContain("RowFallback");
	});

	it("does not forward the attribute through a spread of something else", () => {
		// `styleProps` is a local object. The caller's `data-testid` is dropped by
		// React, and reporting it here claimed an attribute the DOM never carries.
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Save from "./Save";',
				'export default function App() { return <Save data-testid="Save" />; }',
			].join("\n"),
			"src/Save.tsx": [
				"export default function Save(props: Record<string, unknown>) {",
				'  const styleProps = { className: "save" };',
				"  return <button {...styleProps} />;",
				"}",
			].join("\n"),
		});
		// The `<Save data-testid="Save"/>` node keeps the attribute: the caller
		// really did write it, and the census reports it unproven. What must not
		// happen is the host element claiming to render it.
		const button = nodes.find((node) => node.tag === "button");
		expect(claimedIds(button ? [button] : [])).not.toContain("Save");
		expect(button?.unresolved?.reason).toBe("spread-props");
	});

	it("still forwards through a spread that does carry the props", () => {
		// The guard has to keep the real case working, or it trades one wrong
		// answer for a missing one.
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Ok from "./Ok";',
				'export default function App() { return <Ok data-testid="Real" />; }',
			].join("\n"),
			"src/Ok.tsx": [
				"export default function Ok({ className, ...rest }: Record<string, never>) {",
				"  return <button className={className} {...rest} />;",
				"}",
			].join("\n"),
		});
		const button = nodes.find((node) => node.tag === "button");
		expect(button?.testId).toMatchObject({ value: "Real" });
		expect(button?.viaSpread).toBe(true);
	});

	it("does not hand a module-scope helper the caller's bindings", () => {
		// `renderRow` takes no parameters, so nothing was shadowed and the
		// component's own call-site state reached a body that cannot see it. The
		// `rowId` it reads is the module constant.
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Table from "./Table";',
				'export default function App() { return <Table rowId="FromProps" />; }',
			].join("\n"),
			"src/Table.tsx": [
				'const rowId = "module-scope";',
				"function renderRow() { return <tr data-testid={rowId} />; }",
				"export default function Table({ caption }: { caption?: string }) {",
				"  return <table>{caption}{renderRow()}</table>;",
				"}",
			].join("\n"),
		});
		expect(claimedIds(nodes)).not.toContain("FromProps");
	});

	it("does not conclude absence inside a module-scope helper either", () => {
		// The mirror image of the same bug: an empty `provided` set is not evidence
		// that the caller passed nothing, when the scope was never the caller's.
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Panel from "./Panel";',
				"export default function App() { return <Panel />; }",
			].join("\n"),
			"src/Panel.tsx": [
				"function renderBody() { return <div data-testid={bodyId} />; }",
				"declare const bodyId: string;",
				"export default function Panel({ bodyId }: { bodyId?: string }) {",
				"  return <section>{renderBody()}</section>;",
				"}",
			].join("\n"),
		});
		const div = nodes.find((node) => node.tag === "div");
		expect(div?.testIdAbsent).toBeUndefined();
	});

	it("does not resolve a call shadowed by a render prop", () => {
		// `renderIcon` is the caller's function here. Inlining the module-scope one
		// of the same name attached a subtree, and the id in it, to a site that
		// renders something else entirely.
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Toolbar from "./Toolbar";',
				"export default function App() {",
				'  return <Toolbar renderIcon={() => <i data-testid="CallerIcon" />} />;',
				"}",
			].join("\n"),
			"src/Toolbar.tsx": [
				'function renderIcon() { return <i data-testid="ModuleIcon" />; }',
				"export default function Toolbar({ renderIcon }: { renderIcon: () => unknown }) {",
				"  return <div>{renderIcon()}</div>;",
				"}",
			].join("\n"),
		});
		expect(claimedIds(nodes)).not.toContain("ModuleIcon");
	});

	it("does not resolve a call shadowed by a non-function local", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Menu from "./Menu";',
				"export default function App() { return <Menu />; }",
			].join("\n"),
			"src/Menu.tsx": [
				'import { pick } from "./pick";',
				'function renderEntry() { return <li data-testid="ModuleEntry" />; }',
				"export default function Menu({ custom }: { custom?: () => unknown }) {",
				"  const renderEntry = pick(custom);",
				"  return <ul>{renderEntry()}</ul>;",
				"}",
			].join("\n"),
			"src/pick.ts":
				"export const pick = (f?: () => unknown) => f ?? (() => null);",
		});
		expect(claimedIds(nodes)).not.toContain("ModuleEntry");
	});

	it("still inlines a module-scope helper that reads nothing from the caller", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Footer from "./Footer";',
				"export default function App() { return <Footer />; }",
			].join("\n"),
			"src/Footer.tsx": [
				'function renderLegal() { return <small data-testid="Legal" />; }',
				"export default function Footer() {",
				"  return <footer>{renderLegal()}</footer>;",
				"}",
			].join("\n"),
		});
		expect(claimedIds(nodes)).toContain("Legal");
	});

	it("does not render a nested helper's return from an inline callback", () => {
		// `unused` is never called. A descendant scan over the callback body
		// treated its return as the callback's own, so `Ghost` entered the tree as
		// an ordinary observed id — and `mapCoverage` then counts it matchable.
		// `componentReturnExpressions` and `factoryClass` both already filter
		// returns to the function that owns them.
		const { nodes } = treeFor({
			"src/App.tsx": [
				"export default function App() {",
				"  const memo = useMemo(() => {",
				'    function unused() { return <span data-testid="Ghost" />; }',
				"    void unused;",
				'    return <div data-testid="Real" />;',
				"  }, []);",
				'  return <section data-testid="Shell">{memo}</section>;',
				"}",
			].join("\n"),
		});
		expect(claimedIds(nodes)).toContain("Real");
		expect(claimedIds(nodes)).not.toContain("Ghost");
	});
});
