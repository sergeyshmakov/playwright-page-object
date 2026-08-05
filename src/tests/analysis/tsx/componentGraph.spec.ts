import { describe, expect, it } from "vitest";
import {
	collectComponents,
	componentReturnExpressions,
	resolveComponentRef,
} from "../../../analysis/tsx/componentGraph";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import { makeWorkspace, memoryPath } from "../helpers/inMemory";

function resolve(files: Record<string, string>, from: string, tag: string) {
	const ws = makeWorkspace(files);
	const sourceFile = ws.project.getSourceFileOrThrow(memoryPath(from));
	return {
		ws,
		resolution: resolveComponentRef(ws, ws.project, sourceFile, tag),
	};
}

describe("resolveComponentRef", () => {
	it("resolves a default export through a .tsx candidate", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import Card from "./Card";\nexport default function App() { return <Card />; }',
				"src/Card.tsx": "export default function Card() { return <div />; }",
			},
			"src/App.tsx",
			"Card",
		);
		expect(resolution.kind).toBe("local");
		if (resolution.kind === "local") {
			expect(resolution.definition.id).toBe("src/Card.tsx#default");
			expect(resolution.definition.exportKind).toBe("default");
		}
	});

	it("keeps the declared name even when the import is aliased", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import CardAlias from "./Card";\nexport default function App() { return <CardAlias />; }',
				"src/Card.tsx": "export default function Card() { return <div />; }",
			},
			"src/App.tsx",
			"CardAlias",
		);
		if (resolution.kind !== "local") {
			throw new Error("expected a local component");
		}
		expect(resolution.definition.name).toBe("Card");
	});

	it("resolves a named export declared as a const arrow", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import { Card } from "./Card";\nexport default function App() { return <Card />; }',
				"src/Card.tsx": "export const Card = () => <div />;",
			},
			"src/App.tsx",
			"Card",
		);
		expect(resolution.kind).toBe("local");
		if (resolution.kind === "local") {
			expect(resolution.definition.exportKind).toBe("named");
			expect(resolution.definition.id).toBe("src/Card.tsx#Card");
		}
	});

	it("reports a component from another package as external", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import { Button } from "@acme/ui";\nexport default function App() { return <Button />; }',
			},
			"src/App.tsx",
			"Button",
		);
		expect(resolution).toEqual({ kind: "external", module: "@acme/ui" });
	});

	it("reports a dotted tag as unresolved", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import * as UI from "./ui";\nexport default function App() { return <UI.Card />; }',
				"src/ui.tsx": "export const Card = () => <div />;",
			},
			"src/App.tsx",
			"UI.Card",
		);
		expect(resolution.kind).toBe("unresolved");
	});

	it("reads destructured prop names and spread forwarding", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import Card from "./Card";\nexport default function App() { return <Card />; }',
				"src/Card.tsx":
					"export default function Card({ testId, ...rest }: { testId: string }) { return <div data-testid={testId} {...rest} />; }",
			},
			"src/App.tsx",
			"Card",
		);
		if (resolution.kind !== "local") {
			throw new Error("expected a local component");
		}
		expect(resolution.definition.propNames).toEqual(["testId"]);
		expect(resolution.definition.spreadSourceNames).toEqual(["rest"]);
		expect(resolution.definition.forwardsSpread).toBe(true);
	});

	it("reports the prop name, not the local alias, and records the hop", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import Card from "./Card";\nexport default function App() { return <Card />; }',
				"src/Card.tsx":
					"export default function Card({ testId: id }: { testId: string }) { return <div data-testid={id} />; }",
			},
			"src/App.tsx",
			"Card",
		);
		if (resolution.kind !== "local") {
			throw new Error("expected a local component");
		}
		expect(resolution.definition.propNames).toEqual(["testId"]);
		expect([...resolution.definition.propAliases]).toEqual([["id", "testId"]]);
	});
});

describe("componentReturnExpressions", () => {
	it("returns the concise body of an arrow component", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import { Card } from "./Card";\nexport default function App() { return <Card />; }',
				"src/Card.tsx": "export const Card = () => <div />;",
			},
			"src/App.tsx",
			"Card",
		);
		if (resolution.kind !== "local") {
			throw new Error("expected a local component");
		}
		expect(componentReturnExpressions(resolution.definition.fn)).toHaveLength(
			1,
		);
	});

	it("ignores returns that belong to inner callbacks", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import Card from "./Card";\nexport default function App() { return <Card />; }',
				"src/Card.tsx": [
					"export default function Card() {",
					"  const rows = [1].map((n) => { return n * 2; });",
					"  void rows;",
					"  return <div />;",
					"}",
				].join("\n"),
			},
			"src/App.tsx",
			"Card",
		);
		if (resolution.kind !== "local") {
			throw new Error("expected a local component");
		}
		expect(componentReturnExpressions(resolution.definition.fn)).toHaveLength(
			1,
		);
	});
});

describe("collectComponents", () => {
	it("indexes capitalised function and const components", () => {
		const ws = makeWorkspace({
			"src/Card.tsx": [
				"export default function Card() { return <div />; }",
				"export const Badge = () => <span />;",
				"function helper() { return 1; }",
				"void helper;",
			].join("\n"),
		});
		const components = collectComponents(ws, ws.jsxFiles());
		expect(Object.keys(components).sort()).toEqual([
			"src/Card.tsx#Badge",
			"src/Card.tsx#default",
		]);
	});
});

describe("buildTestIdTree — graph traversal", () => {
	const RECURSIVE = {
		"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
		"src/App.tsx": [
			'import Node from "./Node";',
			"export default function App() { return <Node />; }",
		].join("\n"),
		"src/Node.tsx": [
			'import Node from "./Node";',
			'export default function Node() { return <div data-testid="N"><Node /></div>; }',
		].join("\n"),
	};

	it("stops at a recursive component instead of looping", () => {
		const tree = buildTestIdTree(makeWorkspace(RECURSIVE));
		expect(tree.fidelity).toBe("full");
		const node = tree.roots[0];
		expect(node.componentRef).toBe("src/Node.tsx#default");
		const inner = node.children[0].children[0];
		expect(inner).toMatchObject({ tag: "Node", repeated: true });
		expect(inner.children).toEqual([]);
	});

	it("does not expand a component from another package", () => {
		const tree = buildTestIdTree(
			makeWorkspace({
				"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
				"src/App.tsx": [
					'import { Button } from "@acme/ui";',
					"export default function App() { return <Button />; }",
				].join("\n"),
			}),
		);
		expect(tree.roots[0]).toMatchObject({
			tag: "Button",
			nodeType: "component",
			unresolved: { reason: "external-module" },
		});
		expect(tree.roots[0].children).toEqual([]);
	});

	it("merges multiple returns under #branch wrappers", () => {
		const tree = buildTestIdTree(
			makeWorkspace({
				"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
				"src/App.tsx": [
					'import Card from "./Card";',
					"export default function App() { return <Card />; }",
				].join("\n"),
				"src/Card.tsx": [
					"export default function Card({ ok }: { ok: boolean }) {",
					'  if (ok) { return <div data-testid="Yes" />; }',
					'  return <div data-testid="No" />;',
					"}",
				].join("\n"),
			}),
		);
		const branches = tree.roots[0].children;
		expect(branches).toHaveLength(2);
		expect(branches.every((branch) => branch.nodeType === "branch")).toBe(true);
		expect(branches.every((branch) => branch.conditional)).toBe(true);
		expect(
			branches.flatMap((branch) =>
				branch.children.map((child) => child.testId?.value),
			),
		).toEqual(["Yes", "No"]);
	});

	it("honours the depth limit", () => {
		const tree = buildTestIdTree(makeWorkspace(RECURSIVE), { maxDepth: 1 });
		expect(tree.truncated).toBe(true);
		expect(tree.warnings.map((diag) => diag.code)).toContain(
			"depth-limit-reached",
		);
	});

	it("honours the node budget", () => {
		const tree = buildTestIdTree(makeWorkspace(RECURSIVE), { maxNodes: 1 });
		expect(tree.truncated).toBe(true);
	});

	it("degrades to flat fidelity when no entry can be detected", () => {
		const tree = buildTestIdTree(
			makeWorkspace({
				"src/Orphan.tsx":
					'export const Orphan = () => <div data-testid="O" />;',
			}),
		);
		expect(tree.fidelity).toBe("flat");
		expect(tree.roots).toEqual([]);
		expect(tree.fidelityReason).toContain("auto-detected");
		// The inventory is still complete: coverage runs off it, not the tree.
		expect(tree.inventory.map((entry) => entry.value.value)).toEqual(["O"]);
	});

	it("reports a missing explicit entry without throwing", () => {
		const tree = buildTestIdTree(
			makeWorkspace({ "src/A.tsx": "export const A = () => <div />;" }),
			{ entry: "src/Nope.tsx" },
		);
		expect(tree.fidelity).toBe("flat");
		expect(tree.warnings.map((diag) => diag.code)).toContain("entry-not-found");
	});
});
