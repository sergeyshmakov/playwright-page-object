import { describe, expect, it } from "vitest";
import { AnalysisTargetError } from "../../../analysis/diagnostics";
import { buildPageObjectTree } from "../../../analysis/page-objects/tree";
import {
	libImport,
	MEMORY_ROOT_POSIX,
	makeWorkspace,
} from "../helpers/inMemory";
import { PRELUDE, SHARED } from "../helpers/pageObjectFixture";

describe("buildPageObjectTree — structure", () => {
	it("emits a shared control once and references it from both parents", () => {
		const tree = buildPageObjectTree(makeWorkspace(SHARED), "HomePage");
		expect(tree.root).toBe("e2e/HomePage.ts#HomePage");
		expect(Object.keys(tree.defs).sort()).toEqual([
			"e2e/Button.ts#Button",
			"e2e/HomePage.ts#HomePage",
			"e2e/Row.ts#Row",
			"playwright-page-object#ListPageObject",
		]);
		expect(tree.stats.defs).toBe(4);
	});

	it("synthesises stubs for library-owned classes so refs never dangle", () => {
		const tree = buildPageObjectTree(makeWorkspace(SHARED), "HomePage");
		const stub = tree.defs["playwright-page-object#ListPageObject"];
		expect(stub).toMatchObject({
			external: true,
			className: "ListPageObject",
			inheritedApi: "ListPageObject",
			extendsChain: ["PageObject"],
		});
	});

	it("terminates on self-recursion", () => {
		const tree = buildPageObjectTree(
			makeWorkspace({
				"e2e/Node.ts": [
					PRELUDE,
					'@RootSelector("Node")',
					"export class Tree extends RootPageObject {",
					'  @Selector("child")',
					"  accessor Child = new Tree();",
					"}",
				].join("\n"),
			}),
			"Tree",
		);
		expect(Object.keys(tree.defs)).toEqual(["e2e/Node.ts#Tree"]);
		expect(tree.defs["e2e/Node.ts#Tree"].members[0].result).toMatchObject({
			ref: "e2e/Node.ts#Tree",
		});
	});

	it("terminates on mutual recursion", () => {
		const tree = buildPageObjectTree(
			makeWorkspace({
				"e2e/A.ts": [
					PRELUDE,
					'import { B } from "./B";',
					'@RootSelector("A")',
					"export class A extends RootPageObject {",
					'  @Selector("b")',
					"  accessor Child = new B();",
					"}",
				].join("\n"),
				"e2e/B.ts": [
					PRELUDE,
					'import { A } from "./A";',
					"export class B extends PageObject {",
					'  @Selector("a")',
					"  accessor Back = new A();",
					"}",
				].join("\n"),
			}),
			"A",
		);
		expect(Object.keys(tree.defs).sort()).toEqual(["e2e/A.ts#A", "e2e/B.ts#B"]);
		expect(tree.truncated).toBeUndefined();
	});

	// The cycle's far end is already in `defs` and members point at it by `$ref`,
	// so the boundary hides nothing: another level of depth cannot produce a node
	// the payload does not already carry.
	it("does not call a self-recursive class truncated at the depth limit", () => {
		const tree = buildPageObjectTree(
			makeWorkspace({
				"e2e/Node.ts": [
					PRELUDE,
					'@RootSelector("Node")',
					"export class Tree extends RootPageObject {",
					'  @Selector("child")',
					"  accessor Child = new Tree();",
					"}",
				].join("\n"),
			}),
			"Tree",
			{ maxDepth: 1 },
		);
		expect(tree.truncated).toBeUndefined();
		expect(tree.defs["e2e/Node.ts#Tree"].expanded).toBe(true);
		expect(tree.warnings.map((diag) => diag.code)).not.toContain(
			"depth-limit-reached",
		);
	});

	it("does not call a mutual cycle truncated at the depth limit", () => {
		const tree = buildPageObjectTree(
			makeWorkspace({
				"e2e/A.ts": [
					PRELUDE,
					'import { B } from "./B";',
					'@RootSelector("A")',
					"export class A extends RootPageObject {",
					'  @Selector("b")',
					"  accessor Child = new B();",
					"}",
				].join("\n"),
				"e2e/B.ts": [
					PRELUDE,
					'import { A } from "./A";',
					"export class B extends PageObject {",
					'  @Selector("a")',
					"  accessor Back = new A();",
					"}",
				].join("\n"),
			}),
			"A",
			{ maxDepth: 2 },
		);
		expect(tree.truncated).toBeUndefined();
		expect(tree.defs["e2e/B.ts#B"].expanded).toBe(true);
	});
});

describe("buildPageObjectTree — budgets", () => {
	it("stops expanding at the depth limit and says why", () => {
		const tree = buildPageObjectTree(makeWorkspace(SHARED), "HomePage", {
			maxDepth: 1,
		});
		expect(tree.truncated).toBe(true);
		expect(tree.defs["e2e/HomePage.ts#HomePage"].expanded).toBe(false);
		expect(Object.keys(tree.defs)).toEqual(["e2e/HomePage.ts#HomePage"]);
		expect(tree.warnings.map((diag) => diag.code)).toContain(
			"depth-limit-reached",
		);
	});

	// A leaf has nothing below it, so the depth boundary is where the tree ends
	// anyway. Reporting a cut there invents a hole the caller then pays another
	// call and a bigger depth to go and look for.
	it("does not call a leaf truncated just because the depth ran out on it", () => {
		const tree = buildPageObjectTree(
			makeWorkspace({
				"e2e/Leaf.ts": [
					PRELUDE,
					"export class Leaf extends PageObject {",
					'  @Selector("a")',
					"  accessor A!: Locator;",
					"}",
				].join("\n"),
			}),
			"Leaf",
			{ maxDepth: 1 },
		);
		expect(tree.truncated).toBeUndefined();
		expect(tree.defs["e2e/Leaf.ts#Leaf"].expanded).toBe(true);
		expect(tree.warnings.map((diag) => diag.code)).not.toContain(
			"depth-limit-reached",
		);
	});

	// The cap has to bound the payload, which is the whole reason it exists.
	// Emitting a stub per refused class did not: the walk kept visiting edges,
	// so `defs` grew with the entire reachable class set and the warnings grew
	// one per class alongside it.
	it("stops emitting definitions once the node budget is gone", () => {
		const tree = buildPageObjectTree(makeWorkspace(SHARED), "HomePage", {
			maxNodes: 2,
		});

		expect(tree.truncated).toBe(true);
		expect(Object.keys(tree.defs).length).toBeLessThanOrEqual(2);

		const budgetWarnings = tree.warnings.filter(
			(diag) => diag.code === "node-budget-reached",
		);
		expect(
			budgetWarnings,
			"one summary, not one per refused class",
		).toHaveLength(1);
		expect(budgetWarnings[0].message).toMatch(/\d+ more class/);
	});
});

describe("buildPageObjectTree — dangling refs", () => {
	it("never emits a control ref that has no definition", () => {
		const tree = buildPageObjectTree(
			makeWorkspace({
				"e2e/factory.ts":
					"export function makeControl(locator: unknown) { return locator; }",
				"e2e/HomePage.ts": [
					PRELUDE,
					'import { makeControl } from "./factory";',
					'@RootSelector("Home")',
					"export class HomePage extends RootPageObject {",
					'  @Selector("promo", makeControl)',
					"  accessor Promo!: Locator;",
					"}",
				].join("\n"),
			}),
			"HomePage",
		);
		const promo = tree.defs["e2e/HomePage.ts#HomePage"].members[0];
		// A named function is callable but is not a class: the control type is
		// dynamic, not a `e2e/factory.ts#makeControl` graph node nothing defines.
		expect(promo.result).toMatchObject({
			kind: "control",
			ref: null,
			dynamic: true,
		});
		expect(Object.keys(tree.defs)).toEqual(["e2e/HomePage.ts#HomePage"]);
		expect(promo.selector.notes?.join(" ")).toContain("not a class");
	});
});

describe("buildPageObjectTree — aliased imports", () => {
	const ALIASED = {
		"e2e/Ctrl.ts": [
			'import type { Locator } from "@playwright/test";',
			"export class Ctrl { constructor(private readonly _l: Locator) {} }",
		].join("\n"),
		"e2e/HomePage.ts": [
			PRELUDE,
			'import { Ctrl } from "@/Ctrl";',
			'@RootSelector("Home")',
			"export class HomePage extends RootPageObject {",
			'  @Selector("promo", Ctrl)',
			"  accessor Promo!: Ctrl;",
			"}",
		].join("\n"),
	};

	it("expands a control imported through a tsconfig path alias", () => {
		const ws = makeWorkspace(ALIASED);
		ws.project.compilerOptions.set({
			baseUrl: MEMORY_ROOT_POSIX,
			paths: { "@/*": ["e2e/*"] },
		});
		const tree = buildPageObjectTree(ws, "HomePage");
		expect(
			tree.defs["e2e/HomePage.ts#HomePage"].members[0].result,
		).toMatchObject({ kind: "control", ref: "e2e/Ctrl.ts#Ctrl" });
		expect(Object.keys(tree.defs)).toContain("e2e/Ctrl.ts#Ctrl");
	});
});
