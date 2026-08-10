import { describe, expect, it } from "vitest";
import { AnalysisTargetError } from "../../../analysis/diagnostics";
import { toInlineTree } from "../../../analysis/page-objects/inline";
import { buildPageObjectTree } from "../../../analysis/page-objects/tree";
import {
	libImport,
	MEMORY_ROOT_POSIX,
	makeWorkspace,
} from "../helpers/inMemory";

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

	// `./e2e/Row.ts` and `e2e\Row.ts` are how clients spell the path the index
	// knows as `e2e/Row.ts`; neither may read as "no page objects there".
	it("accepts the conventional spellings of a file path", () => {
		for (const target of ["./e2e/Row.ts", "e2e\\Row.ts", "./e2e/Row.ts#Row"]) {
			expect(buildPageObjectTree(makeWorkspace(SHARED), target).root).toBe(
				"e2e/Row.ts#Row",
			);
		}
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

	// The other half of the same question, and the half this path was missing.
	// `Home` is four edits from `HomePage` — past any sane distance ceiling — so
	// only the substring pass finds it, and `map_coverage` was the only caller
	// that ran one.
	it("suggests a partial name that edit distance alone would miss", () => {
		expect.assertions(2);
		try {
			buildPageObjectTree(makeWorkspace(SHARED), "Home");
		} catch (thrown) {
			const error = thrown as AnalysisTargetError;
			expect(error.code).toBe("class_not_found");
			expect(error.suggestions).toContain("HomePage");
		}
	});

	// An invented name has no plausible near match, so the list is empty by
	// design. The message is then the only thing the caller has, and "no page
	// object named X" reads as a naming problem even when the scope found none
	// at all.
	it("says the index is empty rather than only that the name is unknown", () => {
		expect.assertions(3);
		try {
			buildPageObjectTree(
				makeWorkspace({ "src/App.tsx": "export const App = () => null;" }),
				"NoSuchPageObjectXyz",
			);
		} catch (thrown) {
			const error = thrown as AnalysisTargetError;
			expect(error.code).toBe("class_not_found");
			expect(error.suggestions).toEqual([]);
			expect(error.message).toContain("no page objects at all");
		}
	});

	it("counts the index it searched when the name is simply wrong", () => {
		expect.assertions(1);
		try {
			buildPageObjectTree(makeWorkspace(SHARED), "NoSuchPageObjectXyz");
		} catch (thrown) {
			expect((thrown as AnalysisTargetError).message).toMatch(
				/among the \d+ in the index/,
			);
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

	/**
	 * The suggestion list used to be every page-object file in the repository,
	 * sorted. At 305 files that is a wall of text costing more tokens than the
	 * tree the caller asked for, with the answer somewhere inside it.
	 */
	it("ranks file suggestions and caps them at eight", () => {
		expect.assertions(3);
		const many: Record<string, string> = {};
		for (let index = 0; index < 20; index += 1) {
			many[`e2e/area${index}/Other.ts`] = [
				libImport("PageObject"),
				`export class Other${index} extends PageObject {}`,
			].join("\n");
		}
		many["e2e/deep/nested/HomePage.ts"] = [
			libImport("PageObject"),
			"export class HomePage extends PageObject {}",
		].join("\n");

		try {
			buildPageObjectTree(makeWorkspace(many), "HomePage.ts");
		} catch (thrown) {
			const error = thrown as AnalysisTargetError;
			expect(error.code).toBe("file_not_found");
			// A caller who wrote a trailing segment meant that file, so it leads.
			expect(error.suggestions?.[0]).toBe("e2e/deep/nested/HomePage.ts");
			expect(error.suggestions?.length).toBeLessThanOrEqual(8);
		}
	});

	it("caps an ambiguous candidate list at ten", () => {
		expect.assertions(2);
		const many: Record<string, string> = {};
		for (let index = 0; index < 14; index += 1) {
			many[`e2e/area${index}/Page.ts`] = [
				libImport("PageObject"),
				"export class Page extends PageObject {}",
			].join("\n");
		}
		try {
			buildPageObjectTree(makeWorkspace(many), "Page");
		} catch (thrown) {
			const error = thrown as AnalysisTargetError;
			expect(error.code).toBe("ambiguous_class");
			expect(error.candidates).toHaveLength(10);
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

	it("marks a budget stub as truncated rather than as a complete leaf", () => {
		const tree = buildPageObjectTree(makeWorkspace(SHARED), "HomePage", {
			maxNodes: 2,
		});
		const inline = toInlineTree(tree, { maxDepth: 10 });
		const stubs: string[] = [];
		const walk = (node: typeof inline): void => {
			if (tree.defs[node.ref]?.expanded === false) {
				stubs.push(node.ref);
				expect(node.truncated).toBe(true);
				expect(node.members).toBeUndefined();
			}
			for (const member of node.members ?? []) {
				if (member.child) {
					walk(member.child);
				}
				if (member.item) {
					walk(member.item);
				}
			}
		};
		walk(inline);
		expect(stubs.length).toBeGreaterThan(0);
	});
});

describe("buildPageObjectTree — inherited members", () => {
	const INHERITED = {
		"e2e/Badge.ts": [
			'import type { Locator } from "@playwright/test";',
			"export class Badge { constructor(private readonly _l: Locator) {} }",
		].join("\n"),
		"e2e/BasePage.ts": [
			PRELUDE,
			'import { Badge } from "./Badge";',
			'@RootSelector("Base")',
			"export class BasePage extends RootPageObject {",
			'  @Selector("Header")',
			"  accessor Header!: Locator;",
			'  @Selector("BaseShared")',
			"  accessor Shared!: Locator;",
			'  @Selector("Flag", Badge)',
			"  accessor Flag!: Badge;",
			"}",
		].join("\n"),
		"e2e/CheckoutPage.ts": [
			PRELUDE,
			'import { BasePage } from "./BasePage";',
			"export class CheckoutPage extends BasePage {",
			'  @Selector("Submit")',
			"  accessor Submit!: Locator;",
			'  @Selector("OwnShared")',
			"  accessor Shared!: Locator;",
			"}",
		].join("\n"),
	};

	function checkoutTree() {
		const tree = buildPageObjectTree(makeWorkspace(INHERITED), "CheckoutPage");
		return { tree, node: tree.defs["e2e/CheckoutPage.ts#CheckoutPage"] };
	}

	it("lists own members first, then the ones it inherits", () => {
		expect(checkoutTree().node.members.map((member) => member.name)).toEqual([
			"Submit",
			"Shared",
			"Header",
			"Flag",
		]);
	});

	it("lets the subclass member win over the base member of the same name", () => {
		const shared = checkoutTree().node.members.find(
			(member) => member.name === "Shared",
		);
		expect(shared?.selector.testId).toBe("OwnShared");
		expect(shared?.loc.file).toBe("e2e/CheckoutPage.ts");
	});

	it("points an inherited member at the file that declares it", () => {
		const header = checkoutTree().node.members.find(
			(member) => member.name === "Header",
		);
		expect(header?.loc.file).toBe("e2e/BasePage.ts");
	});

	it("expands a control reached only through an inherited member", () => {
		expect(Object.keys(checkoutTree().tree.defs)).toContain(
			"e2e/Badge.ts#Badge",
		);
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
