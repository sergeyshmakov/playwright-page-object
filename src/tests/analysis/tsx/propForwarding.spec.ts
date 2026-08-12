import { describe, expect, it } from "vitest";
import { staticId } from "../../../analysis";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import type { UiNode } from "../../../analysis/types";
import { makeWorkspace } from "../helpers/inMemory";

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

describe("one-hop prop forwarding", () => {
	it("binds a named prop written into the attribute", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Btn from "./Btn";',
				'export default function App() { return <Btn testId="Foo" />; }',
			].join("\n"),
			"src/Btn.tsx": [
				"export default function Btn({ testId }: { testId: string }) {",
				"  return <button data-testid={testId} />;",
				"}",
			].join("\n"),
		});
		const button = nodes.find((node) => node.tag === "button");
		expect(button?.testId).toMatchObject({ kind: "static", value: "Foo" });
		expect(button?.viaProp).toBe("testId");
	});

	it("binds a prop destructured under a different local name", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Btn from "./Btn";',
				'export default function App() { return <Btn testId="Aliased" />; }',
			].join("\n"),
			"src/Btn.tsx": [
				"export default function Btn({ testId: id }: { testId: string }) {",
				"  return <button data-testid={id} />;",
				"}",
			].join("\n"),
		});
		const button = nodes.find((node) => node.tag === "button");
		expect(button?.testId).toMatchObject({ kind: "static", value: "Aliased" });
		expect(button?.viaProp).toBe("id");
	});

	it("binds `props.testId` as well as the destructured form", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Btn from "./Btn";',
				'export default function App() { return <Btn testId="Bar" />; }',
			].join("\n"),
			"src/Btn.tsx": [
				"export default function Btn(props: { testId: string }) {",
				"  return <button data-testid={props.testId} />;",
				"}",
			].join("\n"),
		});
		const button = nodes.find((node) => node.tag === "button");
		expect(button?.testId).toMatchObject({ value: "Bar" });
		expect(button?.viaProp).toBe("testId");
	});

	it("binds the attribute itself through a `{...props}` spread", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Btn from "./Btn";',
				'export default function App() { return <Btn data-testid="Spread" />; }',
			].join("\n"),
			"src/Btn.tsx": [
				"export default function Btn(props: Record<string, unknown>) {",
				"  return <button {...props} />;",
				"}",
			].join("\n"),
		});
		const button = nodes.find((node) => node.tag === "button");
		expect(button?.testId).toMatchObject({ value: "Spread" });
		expect(button?.viaSpread).toBe(true);
	});

	it("marks an unbound spread as unresolved rather than guessing", () => {
		const { nodes } = treeFor({
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
		const button = nodes.find((node) => node.tag === "button");
		expect(button?.testId).toBeUndefined();
		expect(button?.unresolved).toEqual({ reason: "spread-props" });
	});

	it("leaves two-hop forwarding dynamic", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Outer from "./Outer";',
				'export default function App() { return <Outer testId="Deep" />; }',
			].join("\n"),
			"src/Outer.tsx": [
				'import Inner from "./Inner";',
				"export default function Outer({ testId }: { testId: string }) {",
				"  return <Inner innerId={testId} />;",
				"}",
			].join("\n"),
			"src/Inner.tsx": [
				"export default function Inner({ innerId }: { innerId: string }) {",
				"  return <button data-testid={innerId} />;",
				"}",
			].join("\n"),
		});
		const button = nodes.find((node) => node.tag === "button");
		expect(button?.testId?.kind).toBe("dynamic");
		expect(button?.viaProp).toBeUndefined();
	});

	// Reversed deliberately. The call site passes nothing, spreads nothing, and
	// the parameter declares the value right there — the id that renders is
	// "Fallback", and reporting it dynamic sent agents looking for a value the
	// source states outright.
	it("resolves a parameter default when the call site passes nothing", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Btn from "./Btn";',
				"export default function App() { return <Btn />; }",
			].join("\n"),
			"src/Btn.tsx": [
				'export default function Btn({ testId = "Fallback" }: { testId?: string }) {',
				"  return <button data-testid={testId} />;",
				"}",
			].join("\n"),
		});
		const button = nodes.find((node) => node.tag === "button");
		expect(button?.testId).toMatchObject({
			kind: "static",
			value: "Fallback",
		});
		expect(button?.viaDefault).toBe(true);
		expect(button?.viaProp).toBe("testId");
	});

	// A default the walk cannot read is still a default: something renders. The
	// map used to drop it, which left the name looking undeclared and produced
	// `testIdAbsent` — "no selector exists here" — for an element that renders
	// an id on every single render.
	it("reports an unreadable parameter default as unknown, not absent", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Btn from "./Btn";',
				"export default function App() { return <Btn />; }",
			].join("\n"),
			"src/Btn.tsx": [
				'const makeId = () => "generated";',
				"export default function Btn({ testId = makeId() }: { testId?: string }) {",
				"  return <button data-testid={testId} />;",
				"}",
			].join("\n"),
		});
		const button = nodes.find((node) => node.tag === "button");
		expect(button?.testIdAbsent).toBeUndefined();
		expect(button?.testId?.kind).toBe("dynamic");
	});

	// Two branches are two ids. Recording the first one claimed the second never
	// renders, and marked the claim `viaDefault` — proven.
	it("names no branch when the default is itself a static choice", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Btn from "./Btn";',
				"export default function App() { return <Btn />; }",
			].join("\n"),
			"src/Btn.tsx": [
				"export default function Btn({",
				"  big = true,",
				'  testId = big ? "Big" : "Small",',
				"}: { big?: boolean; testId?: string }) {",
				"  return <button data-testid={testId} />;",
				"}",
			].join("\n"),
		});
		const button = nodes.find((node) => node.tag === "button");
		expect(staticId(button?.testId)).toBeUndefined();
		expect(button?.testId?.kind).toBe("dynamic");
		expect(button?.viaDefault).toBeUndefined();
	});

	it("folds a forwarded id into the flat inventory and drops the placeholder", () => {
		const { tree } = treeFor({
			"src/App.tsx": [
				'import Btn from "./Btn";',
				'export default function App() { return <Btn testId="Folded" />; }',
			].join("\n"),
			"src/Btn.tsx": [
				"export default function Btn({ testId }: { testId: string }) {",
				"  return <button data-testid={testId} />;",
				"}",
			].join("\n"),
		});
		const values = tree.inventory.map((entry) => entry.value);
		expect(values.filter((value) => value.kind === "dynamic")).toHaveLength(0);
		expect(values.map(staticId)).toContain("Folded");
		expect(
			tree.inventory.find((entry) => staticId(entry.value) === "Folded")
				?.viaProp,
		).toBe("testId");
	});

	// One location, two render sites, one of them unreadable. Folding the
	// readable one in and deleting the placeholder left the location claiming a
	// single known id, so a selector for whatever the other site passes came
	// back as a dead selector instead of an unknown one.
	it("keeps the placeholder when another site at the same location stayed unknown", () => {
		const { tree } = treeFor({
			"src/Row.tsx": [
				"export default function Row({ rowId }: { rowId?: string }) {",
				"  return <tr data-testid={rowId} />;",
				"}",
			].join("\n"),
			"src/App.tsx": [
				'import Row from "./Row";',
				"export default function App({ runtimeId }: { runtimeId: string }) {",
				"  return (",
				"    <table>",
				'      <Row rowId="Known" />',
				"      <Row rowId={runtimeId} />",
				"    </table>",
				"  );",
				"}",
			].join("\n"),
		});
		const atRow = tree.inventory.filter(
			(entry) => entry.file === "src/Row.tsx",
		);
		expect(atRow.map((entry) => staticId(entry.value))).toContain("Known");
		expect(
			atRow.filter((entry) => entry.value.kind === "dynamic"),
		).toHaveLength(1);
	});

	it("binds a prop destructured under a quoted key", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Btn from "./Btn";',
				'export default function App() { return <Btn data-testid="Quoted" />; }',
			].join("\n"),
			"src/Btn.tsx": [
				'export default function Btn({ "data-testid": id }: Record<string, string>) {',
				"  return <button data-testid={id} />;",
				"}",
			].join("\n"),
		});
		const button = nodes.find((node) => node.tag === "button");
		expect(button?.testId).toMatchObject({ kind: "static", value: "Quoted" });
		expect(button?.viaProp).toBe("id");
	});
});

/**
 * A test id is only a selector if it reaches the DOM. Reporting the *prop name*
 * as the id when the call site passed nothing put strings like "dataTid" in
 * front of agents as if they were real ids — a selector that can never match,
 * invented by the analysis rather than found in the app.
 *
 * Every inference below needs positive evidence from the call site, and the
 * tree root — whose caller is outside the analysed tree — never has any.
 */
describe("test ids that provably do not render at a site", () => {
	const ROW = {
		"src/Row.tsx": [
			"export default function Row({ dataTid }: { dataTid?: string }) {",
			"  return <tr data-testid={dataTid} />;",
			"}",
		].join("\n"),
	};

	const FALLBACK_ROW = {
		"src/Row.tsx": [
			"export default function Row({ dataTid }: { dataTid?: string }) {",
			'  return <tr data-testid={dataTid || "Row"} />;',
			"}",
		].join("\n"),
	};

	function appRendering(site: string): Record<string, string> {
		return {
			"src/App.tsx": [
				'import Row from "./Row";',
				`export default function App({ x, ...rest }: { x: string }) { return ${site}; }`,
			].join("\n"),
		};
	}

	it("reports no id at all when the prop was not passed", () => {
		const { tree, nodes } = treeFor({ ...ROW, ...appRendering("<Row />") });
		const row = nodes.find((node) => node.tag === "tr");
		expect(row?.testId).toBeUndefined();
		expect(row?.testIdAbsent).toBe(true);
		const ids = nodes.map((node) => staticId(node.testId));
		expect(ids).not.toContain("dataTid");
		expect(
			tree.roots.length,
			"sanity: the tree really did reach the row",
		).toBeGreaterThan(0);
	});

	it('resolves a `|| "Row"` fallback when the prop provably arrived empty', () => {
		const { nodes } = treeFor({
			...FALLBACK_ROW,
			...appRendering("<Row />"),
		});
		const row = nodes.find((node) => node.tag === "tr");
		expect(row?.testId).toMatchObject({ kind: "static", value: "Row" });
		expect(row?.viaDefault).toBe(true);
		expect(row?.viaProp).toBe("dataTid");
	});

	it("prefers the bound value over the fallback", () => {
		const { nodes } = treeFor({
			...FALLBACK_ROW,
			...appRendering('<Row dataTid="Explicit" />'),
		});
		const row = nodes.find((node) => node.tag === "tr");
		expect(row?.testId).toMatchObject({ value: "Explicit" });
		expect(row?.viaProp).toBe("dataTid");
		expect(row?.viaDefault).toBeUndefined();
	});

	it("stays dynamic when the prop is passed but unreadable", () => {
		const { nodes } = treeFor({
			...ROW,
			...appRendering("<Row dataTid={x} />"),
		});
		const row = nodes.find((node) => node.tag === "tr");
		// The attribute exists; only its value is out of reach. Saying it is
		// absent would be a different — and false — claim.
		expect(row?.testId?.kind).toBe("dynamic");
		expect(row?.testIdAbsent).toBeUndefined();
	});

	it("refuses to infer absence through a spread at the call site", () => {
		const { nodes } = treeFor({
			...ROW,
			...appRendering("<Row {...rest} />"),
		});
		const row = nodes.find((node) => node.tag === "tr");
		expect(row?.testId?.kind).toBe("dynamic");
		expect(row?.testIdAbsent).toBeUndefined();
	});

	it("never suppresses at the tree root, whose call site is outside the tree", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				"export default function App({ dataTid }: { dataTid?: string }) {",
				"  return <div data-testid={dataTid} />;",
				"}",
			].join("\n"),
		});
		const root = nodes.find((node) => node.tag === "div");
		expect(root?.testId?.kind).toBe("dynamic");
		expect(root?.testIdAbsent).toBeUndefined();
	});

	it("folds a defaulted id into the inventory and drops its placeholder", () => {
		const { tree } = treeFor({
			...FALLBACK_ROW,
			...appRendering("<Row />"),
		});
		const resolved = tree.inventory.filter(
			(entry) => staticId(entry.value) === "Row",
		);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].viaProp).toBe("dataTid");
		expect(
			tree.inventory.filter((entry) => entry.value.kind === "dynamic"),
		).toHaveLength(0);
	});

	it("leaves a suppressed occurrence in the inventory", () => {
		const { tree } = treeFor({ ...ROW, ...appRendering("<Row />") });
		// The same component may be rendered with the prop somewhere the walk
		// never went. Deleting the occurrence would turn a working page-object
		// selector into a reported dead selector.
		const dynamic = tree.inventory.filter(
			(entry) => entry.value.kind === "dynamic" && entry.file === "src/Row.tsx",
		);
		expect(dynamic).toHaveLength(1);
	});
});

describe("test ids written on a component tag", () => {
	// The attribute is a prop until something forwards it to a host element. The
	// occurrence is still inventoried — a page object selecting it must not read
	// as dead — but flagged, so coverage does not count it as rendered.
	it("reports the call-site occurrence as an unproven component prop", () => {
		const { tree } = treeFor({
			"src/App.tsx": [
				'import Card from "./Card";',
				'export default function App() { return <Card data-testid="Ghost" />; }',
			].join("\n"),
			"src/Card.tsx": [
				"export default function Card(props: { children?: unknown }) {",
				"  return <div>{props.children as never}</div>;",
				"}",
			].join("\n"),
		});
		const ghost = tree.inventory.find(
			(entry) => staticId(entry.value) === "Ghost",
		);
		expect(ghost).toMatchObject({ tag: "Card", reach: "component-prop" });
	});

	it("marks the proven host-element occurrence as forwarded", () => {
		const { tree } = treeFor({
			"src/App.tsx": [
				'import Btn from "./Btn";',
				'export default function App() { return <Btn data-testid="Real" />; }',
			].join("\n"),
			"src/Btn.tsx": [
				"export default function Btn(props: Record<string, unknown>) {",
				"  return <button {...props} />;",
				"}",
			].join("\n"),
		});
		const occurrences = tree.inventory.filter(
			(entry) => staticId(entry.value) === "Real",
		);
		expect(occurrences.map((entry) => [entry.tag, entry.reach])).toEqual(
			expect.arrayContaining([
				["Btn", "component-prop"],
				["button", "forwarded"],
			]),
		);
	});
});
