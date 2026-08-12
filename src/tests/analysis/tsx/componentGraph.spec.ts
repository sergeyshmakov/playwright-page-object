import { describe, expect, it } from "vitest";
import { staticId } from "../../../analysis";
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

	// A module that renames a local declaration on the way out —
	// `function Card() {}; export { Card as CheckoutCard }` — resolved to nothing,
	// because only an import binding named `Card` was looked for. The component
	// then became a tree boundary and everything it renders went unseen.
	it("resolves an aliased export of a locally declared component", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import { CheckoutCard } from "./Card";\nexport default function App() { return <CheckoutCard />; }',
				"src/Card.tsx":
					"function Card() { return <div data-testid='c' />; }\nexport { Card as CheckoutCard };",
			},
			"src/App.tsx",
			"CheckoutCard",
		);
		expect(resolution.kind).toBe("local");
		if (resolution.kind === "local") {
			expect(resolution.definition.name).toBe("Card");
			expect(resolution.definition.file).toBe("src/Card.tsx");
		}
	});

	// The importer's local alias is not an identity. Deriving one from it gave the
	// same anonymous component a different id in every file that rendered it, so
	// cross-references pointed at definitions that did not exist.
	it("gives an anonymous default export one id, whatever the importer calls it", () => {
		const files = {
			"src/Card.tsx": "export default () => <div data-testid='c' />;",
			"src/A.tsx":
				'import Alpha from "./Card";\nexport function A() { return <Alpha />; }',
			"src/B.tsx":
				'import Beta from "./Card";\nexport function B() { return <Beta />; }',
		};
		const viaAlpha = resolve(files, "src/A.tsx", "Alpha").resolution;
		const viaBeta = resolve(files, "src/B.tsx", "Beta").resolution;
		if (viaAlpha.kind !== "local" || viaBeta.kind !== "local") {
			throw new Error("expected local components");
		}
		expect(viaAlpha.definition.id).toBe("src/Card.tsx#default");
		expect(viaBeta.definition.id).toBe(viaAlpha.definition.id);
		expect(viaAlpha.definition.exportKind).toBe("default");
		expect(viaAlpha.definition.name).toBe("Card");
	});

	it("names an anonymous default-exported function after its file too", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import Anything from "./Card";\nexport default function App() { return <Anything />; }',
				"src/Card.tsx": "export default function () { return <div />; }",
			},
			"src/App.tsx",
			"Anything",
		);
		if (resolution.kind !== "local") {
			throw new Error("expected a local component");
		}
		expect(resolution.definition.id).toBe("src/Card.tsx#default");
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

	// The tree resolves `<Card/>` straight to this declaration, so leaving it out
	// of the inventory left every `componentRef` pointing at nothing.
	it("indexes a directly default-exported arrow component", () => {
		const ws = makeWorkspace({
			"src/Card.tsx": "export default () => <div data-testid='c' />;",
		});
		const components = collectComponents(ws, ws.jsxFiles());
		expect(Object.keys(components)).toEqual(["src/Card.tsx#default"]);
		expect(components["src/Card.tsx#default"]).toMatchObject({
			name: "Card",
			exportKind: "default",
		});
	});

	it("reads a quoted destructured prop under its real name", () => {
		const ws = makeWorkspace({
			"src/Card.tsx": [
				'export function Card({ "data-testid": id }: { "data-testid"?: string }) {',
				"  return <div data-testid={id} />;",
				"}",
			].join("\n"),
		});
		const components = collectComponents(ws, ws.jsxFiles());
		expect(components["src/Card.tsx#Card"].propNames).toEqual(["data-testid"]);
	});

	it("leaves a computed destructured key out of the prop names", () => {
		const ws = makeWorkspace({
			"src/Card.tsx": [
				"const key = 'data-testid';",
				"export function Card({ [key]: id, title }: Record<string, string>) {",
				"  return <div data-testid={id}>{title}</div>;",
				"}",
			].join("\n"),
		});
		const components = collectComponents(ws, ws.jsxFiles());
		expect(components["src/Card.tsx#Card"].propNames).toEqual(["title"]);
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
		const node = tree.roots[0];
		expect(node.componentRef).toBe("src/Node.tsx#default");
		const inner = node.children[0].children[0];
		expect(inner).toMatchObject({ tag: "Node", repeated: true });
		expect(inner.children).toEqual([]);
		// The cut subtree is a hole like any other: it used to be a silent empty
		// node claiming full fidelity over a tree that stops mid-recursion.
		expect(inner.unresolved).toEqual({ reason: "recursive" });
		expect(tree.fidelity).toBe("partial");
		expect(tree.stats.unresolvedByReason).toEqual({ recursive: 1 });
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

	/**
	 * Scope evidence, not a diagnosis. In a monorepo scanned at one app, whole
	 * packages of components are invisible; a report that cannot say so reads as
	 * proof that the ids inside them do not exist.
	 */
	it("records which bare module a component tag came from", () => {
		const tree = buildTestIdTree(
			makeWorkspace({
				"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
				"src/App.tsx": [
					'import { Button } from "@acme/ui";',
					'import Card from "@acme/ui/card";',
					"export default function App() { return <div><Button /><Card /></div>; }",
				].join("\n"),
			}),
		);
		expect(tree.externalModules).toEqual(["@acme/ui", "@acme/ui/card"]);
		expect(tree.stats.externalComponentTags).toBe(2);
	});

	it("counts nothing for a component reached by a relative import", () => {
		const tree = buildTestIdTree(
			makeWorkspace({
				"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
				"src/App.tsx": [
					'import { Button } from "./Button";',
					"export default function App() { return <Button />; }",
				].join("\n"),
				"src/Button.tsx":
					'export function Button() { return <b data-testid="B" />; }',
			}),
		);
		expect(tree.externalModules).toEqual([]);
		expect(tree.stats.externalComponentTags).toBe(0);
	});

	// `react` is a bare specifier in every one of these files and contributes
	// nothing: `<div>` is not a component tag, so nothing resolves through it.
	it("ignores a bare import that supplies no component tag", () => {
		const tree = buildTestIdTree(
			makeWorkspace({
				"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
				"src/App.tsx": [
					'import { useState } from "react";',
					'export default function App() { void useState; return <div data-testid="A" />; }',
				].join("\n"),
			}),
		);
		expect(tree.externalModules).toEqual([]);
		expect(tree.stats.externalComponentTags).toBe(0);
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
				branch.children.map((child) => staticId(child.testId)),
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
		expect(tree.inventory.map((entry) => staticId(entry.value))).toEqual(["O"]);
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

// A file whose only component is an unnamed default export used to be reported
// as declaring no component at all, which dropped the whole request to a flat
// inventory even though the resolver handles the shape perfectly well.
describe("buildTestIdTree — anonymous default exports as roots", () => {
	it("roots at `export default function () {}`", () => {
		const tree = buildTestIdTree(
			makeWorkspace({
				"src/App.tsx":
					'export default function () { return <div data-testid="root" />; }',
			}),
			{ entry: "src/App.tsx" },
		);
		expect(tree.fidelity).toBe("full");
		expect(tree.roots[0]).toMatchObject({ tag: "div", component: "App" });
	});

	it("roots at `export default () => …`", () => {
		const tree = buildTestIdTree(
			makeWorkspace({
				"src/App.tsx": 'export default () => <div data-testid="root" />;',
			}),
			{ entry: "src/App.tsx" },
		);
		expect(tree.fidelity).toBe("full");
		expect(tree.fidelityReason).toBeUndefined();
		expect(Object.keys(tree.components)).toContain("src/App.tsx#default");
	});

	it("auto-detects an anonymous App component", () => {
		const tree = buildTestIdTree(
			makeWorkspace({
				"src/App.tsx": 'export default () => <div data-testid="root" />;',
			}),
		);
		expect(tree.fidelity).toBe("full");
	});

	// `src/index.tsx` doing `export { default } from "./App"` is an ordinary
	// React entry point. Requiring the resolved declaration to live in the entry
	// file itself dropped that whole request to a flat inventory.
	it("roots an entry barrel at the component it re-exports", () => {
		const tree = buildTestIdTree(
			makeWorkspace({
				"src/index.tsx": 'export { default } from "./App";',
				"src/App.tsx":
					'export default function App() { return <div data-testid="root" />; }',
			}),
			{ entry: "src/index.tsx" },
		);
		expect(tree.fidelity).toBe("full");
		expect(tree.fidelityReason).toBeUndefined();
		expect(tree.roots[0]).toMatchObject({ tag: "div", component: "App" });
		// The id names the declaring file, so it is the same key the component
		// inventory minted — not one derived from the barrel.
		expect(Object.keys(tree.components)).toContain("src/App.tsx#default");
	});

	it("keeps the re-exported component's own name over the barrel's", () => {
		const tree = buildTestIdTree(
			makeWorkspace({
				"src/index.tsx": 'export { Panel as default } from "./Panel";',
				"src/Panel.tsx":
					'export function Panel() { return <div data-testid="panel" />; }',
			}),
			{ entry: "src/index.tsx" },
		);
		expect(tree.fidelity).toBe("full");
		expect(tree.roots[0]).toMatchObject({ tag: "div", component: "Panel" });
	});

	it("still ignores a default export that is not a component", () => {
		const tree = buildTestIdTree(
			makeWorkspace({
				"src/App.tsx": [
					"export function Panel() { return <div data-testid='p' />; }",
					"export default function helper() { return 1; }",
				].join("\n"),
			}),
			{ entry: "src/App.tsx" },
		);
		expect(tree.fidelity).toBe("full");
		expect(tree.roots[0]).toMatchObject({ tag: "div", component: "Panel" });
	});
});
