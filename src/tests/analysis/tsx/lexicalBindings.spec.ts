import { describe, expect, it } from "vitest";
import { staticId } from "../../../analysis";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import type { TestIdTree, UiNode } from "../../../analysis/types";
import { makeWorkspace } from "../helpers/inMemory";

/**
 * Which binding a name in JSX refers to.
 *
 * Split from `renderHelpers.spec.ts`, which is about *inlining* a helper once
 * it has been found. These are about finding it: block scope, a component
 * declared inside another, and a parameter that shadows an import. Every case
 * here was a wrong answer rather than a missing one - the walk expanded some
 * other component's subtree and offered its test ids.
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

function treeOf(files: Record<string, string>, entry = "src/Page.tsx") {
	return buildTestIdTree(makeWorkspace(files), { entry });
}

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

	// A parameter binds the name across the whole body. Falling through to the
	// module-level namesake reported the *imported* component's subtree — ids of
	// something the call site may never pass. Unresolved is the honest answer.
	it("does not expand an import a destructured parameter shadows", () => {
		const tree = treeOf({
			"src/Card.tsx":
				'export default () => <div data-testid="ImportedCard" />;',
			"src/Page.tsx": [
				'import Card from "./Card";',
				"export function Page({ Card }) {",
				'  return <div data-testid="Root"><Card /></div>;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["Root"]);
		expect(JSON.stringify(tree.roots)).not.toContain("ImportedCard");
	});

	it("does not expand an import a plain parameter shadows", () => {
		const tree = treeOf({
			"src/Card.tsx":
				'export default () => <div data-testid="ImportedCard" />;',
			"src/Page.tsx": [
				'import Card from "./Card";',
				"export function Page(Card) {",
				'  return <div data-testid="Root"><Card /></div>;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["Root"]);
	});

	// `const { Card } = registry` binds `Card` exactly as `const Card = …` does.
	// An identifier-only test let the lookup fall through to the import and
	// expand an unrelated component's subtree.
	it("does not expand an import a destructured local shadows", () => {
		const tree = treeOf({
			"src/Card.tsx":
				'export default () => <div data-testid="ImportedCard" />;',
			"src/Page.tsx": [
				'import Card from "./Card";',
				'import { registry } from "./registry";',
				"export function Page() {",
				"  const { Card } = registry;",
				'  return <div data-testid="Root"><Card /></div>;',
				"}",
			].join("\n"),
			"src/registry.ts": "export const registry: Record<string, any> = {};",
		});
		expect(ids(tree)).toEqual(["Root"]);
		expect(JSON.stringify(tree.roots)).not.toContain("ImportedCard");
	});

	// Found by sweeping the binding forms rather than waiting for each to be
	// reported: a class, a `for` header and a `catch` header all bind a name,
	// and none of them is a variable statement in a block.
	it("does not expand an import a local class shadows", () => {
		const tree = treeOf({
			"src/Card.tsx":
				'export default () => <div data-testid="ImportedCard" />;',
			"src/Page.tsx": [
				'import Card from "./Card";',
				"export function Page() {",
				"  class Card { render() { return null; } }",
				"  void Card;",
				'  return <div data-testid="Root"><Card /></div>;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["Root"]);
	});

	it("does not expand an import a for-of header shadows", () => {
		const tree = treeOf({
			"src/Card.tsx":
				'export default () => <div data-testid="ImportedCard" />;',
			"src/Page.tsx": [
				'import Card from "./Card";',
				"export function Page({ cards }) {",
				"  for (const Card of cards) {",
				'    return <div data-testid="Root"><Card /></div>;',
				"  }",
				"  return null;",
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["Root"]);
	});

	it("does not expand an import a catch binding shadows", () => {
		const tree = treeOf({
			"src/Card.tsx":
				'export default () => <div data-testid="ImportedCard" />;',
			"src/Page.tsx": [
				'import Card from "./Card";',
				"export function Page() {",
				"  try {",
				"    throw new Error('x');",
				"  } catch (Card) {",
				'    return <div data-testid="Root"><Card /></div>;',
				"  }",
				"}",
			].join("\n"),
		});
		expect(ids(tree)).toEqual(["Root"]);
	});

	// A `default:` clause carries statements without a block of its own, and
	// `DefaultClause` is not `CaseClause`. Written `default: { … }` the same
	// switch was fine, because the braces make a `Block` — so this failed on the
	// brace-less spelling only.
	it("does not expand an import a default-clause local shadows", () => {
		const tree = treeOf({
			"src/Card.tsx":
				'export default () => <div data-testid="ImportedCard" />;',
			"src/Page.tsx": [
				'import Card from "./Card";',
				'import { registry } from "./registry";',
				"export function Page({ kind }) {",
				"  switch (kind) {",
				"    default:",
				"      const Card = registry.Card;",
				'      return <div data-testid="Root"><Card /></div>;',
				"  }",
				"}",
			].join("\n"),
			"src/registry.ts": "export const registry: Record<string, any> = {};",
		});
		expect(ids(tree)).toEqual(["Root"]);
	});

	// `var` is function-scoped, so a declaration nested in an `if` shadows the
	// name for the whole body — including the `return` written outside that
	// block. A walk that reads each enclosing statement list cannot see it.
	// `const` in the same position correctly does not shadow, and the
	// body-level `var` already worked; only the nested one fell through.
	it("does not expand an import a nested `var` shadows", () => {
		const tree = treeOf({
			"src/Card.tsx":
				'export default () => <div data-testid="ImportedCard" />;',
			"src/Page.tsx": [
				'import Card from "./Card";',
				'const LocalCard = () => <div data-testid="LocalCard" />;',
				"export function Page({ flag }) {",
				"  if (flag) { var Card = LocalCard; }",
				'  return <div data-testid="Root"><Card /></div>;',
				"}",
			].join("\n"),
		});
		expect(ids(tree)).not.toContain("ImportedCard");
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
