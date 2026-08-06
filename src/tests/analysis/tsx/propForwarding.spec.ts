import { describe, expect, it } from "vitest";
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

	it("leaves a defaulted prop dynamic when the call site passes nothing", () => {
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
		expect(button?.testId?.kind).toBe("dynamic");
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
		expect(values.map((value) => value.value)).toContain("Folded");
		expect(
			tree.inventory.find((entry) => entry.value.value === "Folded")?.viaProp,
		).toBe("testId");
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

describe("test ids written on a component tag", () => {
	// The attribute is a prop until something forwards it to a host element. The
	// occurrence is still inventoried — a page object selecting it must not read
	// as dead — but flagged, so coverage does not count it as rendered.
	it("flags the call-site occurrence as unforwarded", () => {
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
		const ghost = tree.inventory.find((entry) => entry.value.value === "Ghost");
		expect(ghost).toMatchObject({ tag: "Card", unforwarded: true });
	});

	it("leaves the proven host-element occurrence unflagged", () => {
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
			(entry) => entry.value.value === "Real",
		);
		expect(occurrences.map((entry) => [entry.tag, entry.unforwarded])).toEqual(
			expect.arrayContaining([
				["Btn", true],
				["button", undefined],
			]),
		);
	});
});
