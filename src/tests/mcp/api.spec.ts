import { describe, expect, it } from "vitest";
import type {
	MemberNode,
	MemberResult,
	PageObjectNode,
	PageObjectTree,
	SelectorInfo,
} from "../../analysis";
import { createFixtures } from "../../fixtures";
import { apiHintsFor } from "../../mcp/api";
import { ListPageObject } from "../../page-objects/ListPageObject";
import { PageObject } from "../../page-objects/PageObject";
import { RootPageObject } from "../../page-objects/RootPageObject";

/**
 * `apiHints` is static text describing this package's own runtime classes, so
 * the one way it can be wrong is by drifting from them - a renamed helper, or a
 * line that promises a method nobody wrote. These tests read the method names
 * back out of the shipped strings and check them against the real prototypes,
 * which is the only check that keeps prose and code in step.
 */

const selector: SelectorInfo = {
	kind: "testId",
	decorator: "Selector",
	raw: '@Selector("Row")',
	dynamic: false,
	testId: "Row",
};

function member(name: string, result: MemberResult): MemberNode {
	return {
		name,
		loc: { file: "src/Page.ts", line: 1 },
		visibility: "public",
		selector,
		result,
	};
}

function def(
	className: string,
	inheritedApi: PageObjectNode["inheritedApi"],
	members: MemberNode[] = [],
): PageObjectNode {
	return {
		id: `src/${className}.ts#${className}`,
		className,
		file: `src/${className}.ts`,
		loc: { file: `src/${className}.ts`, line: 1 },
		hostKind: inheritedApi === "RootPageObject" ? "rootPageObject" : "fragment",
		scope: "root-selector",
		extendsChain: inheritedApi ? [inheritedApi] : [],
		inheritedApi,
		members,
		methods: [],
		expanded: true,
	};
}

function treeOf(defs: PageObjectNode[]): PageObjectTree {
	return {
		schemaVersion: 1,
		projectRoot: "/repo",
		testIdAttribute: "data-testid",
		testIdAttributeSource: "default",
		root: defs[0]?.id ?? "",
		defs: Object.fromEntries(defs.map((one) => [one.id, one])),
		warnings: [],
		stats: {
			defs: defs.length,
			members: 0,
			methods: 0,
			dynamic: 0,
			parseMs: 0,
		},
	};
}

/** Every `.name` the prose mentions, in order. */
function mentioned(line: string): string[] {
	return [...line.matchAll(/\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
}

/**
 * Names the PageObject line attributes to Playwright rather than to us. They
 * are asserted absent from our prototype as well as excluded from the drift
 * check, so the sentence "`.$` is the Playwright Locator" cannot quietly start
 * describing methods we own.
 */
const LOCATOR_METHODS = ["click", "fill", "textContent"];

describe("apiHints", () => {
	it("names only methods PageObject actually has", () => {
		const hints = apiHintsFor(treeOf([def("Fragment", "PageObject")]));
		const line = hints?.PageObject ?? "";
		expect(line).not.toBe("");

		const named = mentioned(line).filter(
			(name) => !LOCATOR_METHODS.includes(name),
		);
		expect(named.length).toBeGreaterThan(5);
		for (const name of new Set(named)) {
			expect(name in PageObject.prototype, `PageObject.${name}`).toBe(true);
		}
		for (const name of LOCATOR_METHODS) {
			expect(name in PageObject.prototype, `PageObject.${name}`).toBe(false);
		}
	});

	it("names only methods ListPageObject actually has", () => {
		const hints = apiHintsFor(
			treeOf([
				def("Page", "RootPageObject", [
					member("rows", {
						kind: "list",
						listClassName: "ListPageObject",
						listRef: null,
						itemClassName: "Row",
						itemRef: null,
					}),
				]),
			]),
		);
		const line = hints?.ListPageObject ?? "";
		expect(line).not.toBe("");

		const named = new Set(mentioned(line));
		expect(named.size).toBeGreaterThan(10);
		for (const name of named) {
			expect(name in ListPageObject.prototype, `ListPageObject.${name}`).toBe(
				true,
			);
		}
	});

	it("promises a root constructor and a fixture helper that exist", () => {
		const hints = apiHintsFor(treeOf([def("CheckoutPage", "RootPageObject")]));
		const line = hints?.RootPageObject ?? "";

		expect(line).toContain("new CheckoutPage(page)");
		expect(line).toContain("createFixtures(");
		// The two things that sentence claims are constructible/callable.
		expect(RootPageObject.length).toBe(1);
		expect(typeof createFixtures).toBe("function");
	});

	it("explains a list member's bases even when the stub was cut", () => {
		// `listRef: null` is what a depth-limited or budget-cut tree ships: the
		// member says "list", and no def in the payload has inheritedApi at all.
		const hints = apiHintsFor(
			treeOf([
				def("Page", null, [
					member("rows", {
						kind: "list",
						listClassName: "ListPageObject",
						listRef: null,
						itemClassName: null,
						itemRef: null,
					}),
				]),
			]),
		);
		expect(Object.keys(hints ?? {})).toEqual([
			"members",
			"PageObject",
			"ListPageObject",
		]);
	});

	it("says nothing about a list for a tree that holds none", () => {
		const hints = apiHintsFor(
			treeOf([
				def("Page", "RootPageObject", [member("input", { kind: "locator" })]),
			]),
		);
		expect(Object.keys(hints ?? {})).toEqual([
			"members",
			"RootPageObject",
			"PageObject",
		]);
	});

	it("returns nothing for a tree with no members and no known base", () => {
		expect(apiHintsFor(treeOf([def("Plain", null)]))).toBeUndefined();
		expect(apiHintsFor(treeOf([]))).toBeUndefined();
	});
});
