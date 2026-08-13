import { describe, expect, it } from "vitest";
import { discoverPageObjects } from "../../../analysis/page-objects/discover";
import {
	libImport,
	MEMORY_ROOT_POSIX,
	makeWorkspace,
} from "../helpers/inMemory";

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

	// The count in the index and the list in the tree are read as the same
	// number by anyone comparing them, so they have to be counted the same way.
	it("counts inherited methods, the way the tree lists them", () => {
		const index = discoverPageObjects(
			makeWorkspace({
				...FILES,
				"e2e/Base.ts": [
					libImport("RootPageObject"),
					"export class Base extends RootPageObject {",
					"  async login() {}",
					"  async logout() {}",
					"}",
				].join("\n"),
				"e2e/HomePage.ts": ROOT.replace(
					"export class HomePage extends RootPageObject {",
					"export class HomePage extends Base {\n  // eslint-disable-next-line\n  static readonly _u = 0;",
				).replace(
					'import { Row } from "./Row";',
					'import { Row } from "./Row";\nimport { Base } from "./Base";',
				),
			}),
		);
		const home = index.pageObjects.find(
			(entry) => entry.className === "HomePage",
		);
		expect(home?.counts.methods).toBe(3);
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

/**
 * A decorated `accessor` installs its get/set pair on the prototype, so a
 * subclass really does expose every selector its project-local bases declare.
 */
describe("discoverPageObjects — inherited members", () => {
	const INHERITED = {
		"e2e/Badge.ts": [
			'import type { Locator } from "@playwright/test";',
			"export class Badge { constructor(private readonly _l: Locator) {} }",
		].join("\n"),
		"e2e/BasePage.ts": [
			'import type { Locator } from "@playwright/test";',
			libImport("RootPageObject", "RootSelector", "Selector"),
			'import { Badge } from "./Badge";',
			'@RootSelector("Base")',
			"export class BasePage extends RootPageObject {",
			'  @Selector("Header")',
			"  accessor Header!: Locator;",
			'  @Selector("BaseShared")',
			"  accessor Shared!: Locator;",
			'  @Selector("Flag", Badge)',
			"  accessor Flag!: Badge;",
			"  async baseHelper() {}",
			"}",
		].join("\n"),
		"e2e/CheckoutPage.ts": [
			'import type { Locator } from "@playwright/test";',
			libImport("Selector"),
			'import { BasePage } from "./BasePage";',
			"export class CheckoutPage extends BasePage {",
			'  @Selector("Submit")',
			"  accessor Submit!: Locator;",
			'  @Selector("OwnShared")',
			"  accessor Shared!: Locator;",
			"}",
		].join("\n"),
	};

	function checkout() {
		const index = discoverPageObjects(makeWorkspace(INHERITED));
		const entry = index.pageObjects.find(
			(candidate) => candidate.className === "CheckoutPage",
		);
		if (!entry) {
			throw new Error("CheckoutPage was not discovered");
		}
		return entry;
	}

	it("counts inherited decorated accessors as part of the surface", () => {
		// Submit + Shared (own) + Header + Flag (inherited); `Shared` is not
		// counted twice.
		expect(checkout().counts.members).toBe(4);
	});

	it("does not report the base class's own members twice", () => {
		const index = discoverPageObjects(makeWorkspace(INHERITED));
		const base = index.pageObjects.find(
			(entry) => entry.className === "BasePage",
		);
		expect(base?.counts.members).toBe(3);
	});

	it("keeps a class with no local base unchanged", () => {
		const index = discoverPageObjects(makeWorkspace(FILES));
		const home = index.pageObjects.find(
			(entry) => entry.className === "HomePage",
		);
		expect(home?.counts.members).toBe(3);
	});

	// A subclass `static Header()` sits on the constructor; the base's
	// `@Selector("Header") accessor Header` sits on the prototype, so instances
	// still inherit the selector. Keyed on the name alone the static hid it, and
	// the member left the counts, the tree and coverage at once — the same fix
	// the method collector already had.
	it("does not let a subclass static shadow an inherited selector", () => {
		const index = discoverPageObjects(
			makeWorkspace({
				...INHERITED,
				"e2e/StaticPage.ts": [
					libImport("Selector"),
					'import { BasePage } from "./BasePage";',
					"export class StaticPage extends BasePage {",
					"  static Header() {}",
					"}",
				].join("\n"),
			}),
		);
		const entry = index.pageObjects.find(
			(candidate) => candidate.className === "StaticPage",
		);
		// Header + Shared + Flag, all inherited; the static hides none of them.
		expect(entry?.counts.members).toBe(3);
	});
});

describe("discoverPageObjects — tsconfig path aliases", () => {
	const ALIASED = {
		"e2e/Ctrl.ts": [
			'import type { Locator } from "@playwright/test";',
			"export class Ctrl { constructor(private readonly _l: Locator) {} }",
		].join("\n"),
		"e2e/HomePage.ts": [
			'import type { Locator } from "@playwright/test";',
			libImport("RootPageObject", "RootSelector", "Selector"),
			'import { Ctrl } from "@/Ctrl";',
			'@RootSelector("Home")',
			"export class HomePage extends RootPageObject {",
			'  @Selector("promo", Ctrl)',
			"  accessor Promo!: Ctrl;",
			"}",
		].join("\n"),
	};

	function aliasedWorkspace() {
		const ws = makeWorkspace(ALIASED);
		ws.project.compilerOptions.set({
			baseUrl: MEMORY_ROOT_POSIX,
			paths: { "@/*": ["e2e/*"] },
		});
		return ws;
	}

	it("expands a control imported through an alias", () => {
		const index = discoverPageObjects(aliasedWorkspace(), {
			includeControls: true,
		});
		const ctrl = index.pageObjects.find((entry) => entry.className === "Ctrl");
		expect(ctrl?.id).toBe("e2e/Ctrl.ts#Ctrl");
		expect(ctrl?.discoveredBy).toEqual(["factoryArg"]);
		expect(ctrl?.hostKind).toBe("externalControl");
	});

	it("still treats a genuinely external import as external", () => {
		const index = discoverPageObjects(aliasedWorkspace(), {
			includeControls: true,
		});
		expect(index.pageObjects.map((entry) => entry.className)).not.toContain(
			"Locator",
		);
	});
});
