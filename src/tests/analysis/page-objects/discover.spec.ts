import { describe, expect, it } from "vitest";
import { discoverPageObjects } from "../../../analysis/page-objects/discover";
import { libImport, makeWorkspace } from "../helpers/inMemory";

const ROOT = [
	'import type { Locator } from "@playwright/test";',
	libImport(
		"ListPageObject",
		"ListSelector",
		"RootPageObject",
		"RootSelector",
		"Selector",
	),
	'import { Ctrl } from "./Ctrl";',
	'import { Row } from "./Row";',
	'@RootSelector("Home")',
	"export class HomePage extends RootPageObject {",
	'  @Selector("promo", Ctrl)',
	"  accessor Promo!: Ctrl;",
	'  @ListSelector("Row_")',
	"  accessor Rows = new ListPageObject(Row);",
	'  @Selector("raw")',
	"  accessor Raw!: Locator;",
	"  async go() {}",
	"}",
].join("\n");

const FILES = {
	"e2e/HomePage.ts": ROOT,
	"e2e/Ctrl.ts": [
		'import type { Locator } from "@playwright/test";',
		"export class Ctrl { constructor(private readonly _l: Locator) {} }",
	].join("\n"),
	"e2e/Row.ts": [
		libImport("PageObject"),
		"export class Row extends PageObject {}",
	].join("\n"),
	"e2e/fixtures.ts": [
		libImport("createFixtures"),
		'import { HomePage } from "./HomePage";',
		"export const fixtures = createFixtures({ home: HomePage, landing: HomePage });",
	].join("\n"),
};

describe("discoverPageObjects", () => {
	it("finds classes by decorator, base class, fixture and factory argument", () => {
		const index = discoverPageObjects(makeWorkspace(FILES), {
			includeControls: true,
		});
		const byId = new Map(index.pageObjects.map((entry) => [entry.id, entry]));

		expect(byId.get("e2e/HomePage.ts#HomePage")?.discoveredBy).toEqual([
			"baseClass",
			"decorator",
			"fixture",
		]);
		// A `ListPageObject` item type counts as a factory-argument reference too,
		// so `Row` carries both kinds of evidence in one entry.
		expect(byId.get("e2e/Row.ts#Row")?.discoveredBy).toEqual([
			"baseClass",
			"factoryArg",
		]);
		expect(byId.get("e2e/Ctrl.ts#Ctrl")?.discoveredBy).toEqual(["factoryArg"]);
		expect(byId.get("e2e/Ctrl.ts#Ctrl")?.hostKind).toBe("externalControl");
	});

	it("hides factory-argument-only controls unless asked", () => {
		const ws = makeWorkspace(FILES);
		const withoutControls = discoverPageObjects(ws);
		expect(
			withoutControls.pageObjects.map((entry) => entry.className),
		).not.toContain("Ctrl");
		const withControls = discoverPageObjects(ws, { includeControls: true });
		expect(withControls.pageObjects.map((entry) => entry.className)).toContain(
			"Ctrl",
		);
	});

	it("merges evidence into one entry rather than duplicating", () => {
		const index = discoverPageObjects(makeWorkspace(FILES));
		const matches = index.pageObjects.filter(
			(entry) => entry.className === "HomePage",
		);
		expect(matches).toHaveLength(1);
	});

	it("lists every fixture binding for a class", () => {
		const index = discoverPageObjects(makeWorkspace(FILES));
		const home = index.pageObjects.find(
			(entry) => entry.className === "HomePage",
		);
		expect(home?.fixtures.map((binding) => binding.name).sort()).toEqual([
			"home",
			"landing",
		]);
	});

	it("counts members, methods and dynamic members", () => {
		const index = discoverPageObjects(makeWorkspace(FILES));
		const home = index.pageObjects.find(
			(entry) => entry.className === "HomePage",
		);
		expect(home?.counts).toEqual({
			members: 3,
			methods: 1,
			dynamicMembers: 0,
		});
	});

	it("orders fixture-bound roots first, then nested objects, then controls", () => {
		const index = discoverPageObjects(makeWorkspace(FILES), {
			includeControls: true,
		});
		expect(index.pageObjects.map((entry) => entry.className)).toEqual([
			"HomePage",
			"Row",
			"Ctrl",
		]);
	});

	it("keeps same-named classes in different files distinct", () => {
		const index = discoverPageObjects(
			makeWorkspace({
				"e2e/a/Page.ts": [
					libImport("PageObject"),
					"export class Page extends PageObject {}",
				].join("\n"),
				"e2e/b/Page.ts": [
					libImport("PageObject"),
					"export class Page extends PageObject {}",
				].join("\n"),
			}),
		);
		expect(index.pageObjects.map((entry) => entry.id).sort()).toEqual([
			"e2e/a/Page.ts#Page",
			"e2e/b/Page.ts#Page",
		]);
	});

	it("honours include and exclude globs", () => {
		const ws = makeWorkspace(FILES);
		const only = discoverPageObjects(ws, { include: ["e2e/Row.ts"] });
		expect(only.pageObjects.map((entry) => entry.className)).toEqual(["Row"]);
		expect(only.stats.filesScanned).toBe(1);

		const without = discoverPageObjects(ws, { exclude: ["e2e/Row.ts"] });
		expect(without.pageObjects.map((entry) => entry.className)).not.toContain(
			"Row",
		);
	});

	it("reports the resolved test id attribute and its source", () => {
		const index = discoverPageObjects(makeWorkspace(FILES));
		expect(index.testIdAttribute).toBe("data-testid");
		expect(index.testIdAttributeSource).toBe("default");

		const overridden = discoverPageObjects(
			makeWorkspace(FILES, { attribute: "data-qa" }),
		);
		expect(overridden.testIdAttribute).toBe("data-qa");
		expect(overridden.testIdAttributeSource).toBe("param");
	});

	it("marks the second identical call as cached", () => {
		const ws = makeWorkspace(FILES);
		expect(discoverPageObjects(ws).stats.cached).toBe(false);
		expect(discoverPageObjects(ws).stats.cached).toBe(true);
	});
});
