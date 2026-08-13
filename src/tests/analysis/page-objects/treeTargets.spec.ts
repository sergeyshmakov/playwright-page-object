import { describe, expect, it } from "vitest";
import { AnalysisTargetError } from "../../../analysis/diagnostics";
import { buildPageObjectTree } from "../../../analysis/page-objects/tree";
import {
	libImport,
	MEMORY_ROOT_POSIX,
	makeWorkspace,
} from "../helpers/inMemory";
import { PRELUDE, SHARED } from "../helpers/pageObjectFixture";

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

	// The number and `list_page_objects`' `total` disagree by design — this one
	// counts distinct names and covers controls, that one counts classes and
	// hides them — so it has to say what it counts. Unlabelled, a field repository
	// reported 363 here next to 364 there and the reader went hunting for an
	// off-by-one that was two different questions.
	it("counts the index it searched, and says what it counted", () => {
		expect.assertions(2);
		try {
			buildPageObjectTree(makeWorkspace(SHARED), "NoSuchPageObjectXyz");
		} catch (thrown) {
			const message = (thrown as AnalysisTargetError).message;
			expect(message).toMatch(/among the \d+ distinct page-object name\(s\)/);
			expect(message).not.toMatch(/among the \d+ in the index/);
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
