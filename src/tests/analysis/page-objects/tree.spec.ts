import { describe, expect, it } from "vitest";
import { AnalysisTargetError } from "../../../analysis/diagnostics";
import { toInlineTree } from "../../../analysis/page-objects/inline";
import { buildPageObjectTree } from "../../../analysis/page-objects/tree";
import { libImport, makeWorkspace } from "../helpers/inMemory";

const PRELUDE = [
	'import type { Locator } from "@playwright/test";',
	libImport(
		"ListPageObject",
		"ListSelector",
		"PageObject",
		"RootPageObject",
		"RootSelector",
		"Selector",
	),
].join("\n");

const SHARED = {
	"e2e/Button.ts": [
		libImport("PageObject"),
		"export class Button extends PageObject {}",
	].join("\n"),
	"e2e/Row.ts": [
		PRELUDE,
		'import { Button } from "./Button";',
		"export class Row extends PageObject {",
		'  @Selector("remove")',
		"  accessor Remove = new Button();",
		"}",
	].join("\n"),
	"e2e/HomePage.ts": [
		PRELUDE,
		'import { Button } from "./Button";',
		'import { Row } from "./Row";',
		'@RootSelector("Home")',
		"export class HomePage extends RootPageObject {",
		'  @Selector("apply")',
		"  accessor Apply = new Button();",
		'  @ListSelector("Row_")',
		"  accessor Rows = new ListPageObject(Row);",
		"}",
	].join("\n"),
};

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

	it("emits stubs once the node budget is gone", () => {
		const tree = buildPageObjectTree(makeWorkspace(SHARED), "HomePage", {
			maxNodes: 2,
		});
		expect(tree.truncated).toBe(true);
		expect(tree.warnings.map((diag) => diag.code)).toContain(
			"node-budget-reached",
		);
		const stubbed = Object.values(tree.defs).filter((def) => !def.expanded);
		expect(stubbed.length).toBeGreaterThan(0);
		expect(stubbed[0].members).toHaveLength(0);
	});
});

describe("buildPageObjectTree — target resolution", () => {
	it("accepts a bare class name", () => {
		const tree = buildPageObjectTree(makeWorkspace(SHARED), "Row");
		expect(tree.root).toBe("e2e/Row.ts#Row");
	});

	it("accepts `path.ts#Class`", () => {
		const tree = buildPageObjectTree(makeWorkspace(SHARED), "e2e/Row.ts#Row");
		expect(tree.root).toBe("e2e/Row.ts#Row");
	});

	it("accepts a file path with a single page object", () => {
		const tree = buildPageObjectTree(makeWorkspace(SHARED), "e2e/Row.ts");
		expect(tree.root).toBe("e2e/Row.ts#Row");
	});

	it("accepts `fixture:name`", () => {
		const tree = buildPageObjectTree(
			makeWorkspace({
				...SHARED,
				"e2e/fixtures.ts": [
					libImport("createFixtures"),
					'import { HomePage } from "./HomePage";',
					"export const fixtures = createFixtures({ home: HomePage });",
				].join("\n"),
			}),
			"fixture:home",
		);
		expect(tree.root).toBe("e2e/HomePage.ts#HomePage");
	});

	it("throws class_not_found with typo suggestions", () => {
		expect.assertions(3);
		try {
			buildPageObjectTree(makeWorkspace(SHARED), "HomePge");
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(AnalysisTargetError);
			const error = thrown as AnalysisTargetError;
			expect(error.code).toBe("class_not_found");
			expect(error.suggestions).toContain("HomePage");
		}
	});

	it("throws ambiguous_class with the candidate list", () => {
		expect.assertions(2);
		const files = {
			"e2e/a/Page.ts": [
				libImport("PageObject"),
				"export class Page extends PageObject {}",
			].join("\n"),
			"e2e/b/Page.ts": [
				libImport("PageObject"),
				"export class Page extends PageObject {}",
			].join("\n"),
		};
		try {
			buildPageObjectTree(makeWorkspace(files), "Page");
		} catch (thrown) {
			const error = thrown as AnalysisTargetError;
			expect(error.code).toBe("ambiguous_class");
			expect(error.candidates).toEqual([
				"e2e/a/Page.ts#Page",
				"e2e/b/Page.ts#Page",
			]);
		}
	});

	it("throws file_not_found for a path with no page objects", () => {
		expect.assertions(1);
		try {
			buildPageObjectTree(makeWorkspace(SHARED), "e2e/Nope.ts");
		} catch (thrown) {
			expect((thrown as AnalysisTargetError).code).toBe("file_not_found");
		}
	});
});

describe("inline projection", () => {
	it("nests members and marks a repeat", () => {
		const tree = buildPageObjectTree(makeWorkspace(SHARED), "HomePage", {
			format: "inline",
		});
		expect(tree.inline).toBeDefined();
		const inline = tree.inline;
		if (!inline) {
			throw new Error("inline view missing");
		}
		expect(inline.className).toBe("HomePage");
		const apply = inline.members?.find((member) => member.name === "Apply");
		expect(apply?.child?.className).toBe("Button");
		const rows = inline.members?.find((member) => member.name === "Rows");
		expect(rows?.item?.className).toBe("Row");
		// Button appears under HomePage.Apply first, so the copy under Row is a repeat.
		const remove = rows?.item?.members?.find(
			(member) => member.name === "Remove",
		);
		expect(remove?.child?.repeated).toBe(true);
	});

	it("marks a back-edge as cyclic", () => {
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
		const inline = toInlineTree(tree);
		expect(inline.members?.[0].child).toMatchObject({ cyclic: true });
	});

	it("truncates at its own depth limit", () => {
		const tree = buildPageObjectTree(makeWorkspace(SHARED), "HomePage");
		const inline = toInlineTree(tree, { maxDepth: 1 });
		const apply = inline.members?.find((member) => member.name === "Apply");
		expect(apply?.child).toMatchObject({ truncated: true });
	});
});
