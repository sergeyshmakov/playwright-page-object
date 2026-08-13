import { describe, expect, it } from "vitest";
import { staticId } from "../../../analysis";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import { makeWorkspace } from "../helpers/inMemory";

/**
 * What the tree walk does with the component graph underneath it.
 *
 * These were in `componentGraph.spec.ts`, testing `tsx/tree.ts` through it. The
 * subject is the traversal - which tags it follows, what it does with an
 * anonymous default export at the root - not how a tag resolves to a
 * definition, which is next door.
 */

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
