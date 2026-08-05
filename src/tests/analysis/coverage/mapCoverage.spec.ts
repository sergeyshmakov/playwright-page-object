import { describe, expect, it } from "vitest";
import { buildCoverageReport } from "../../../analysis/coverage/mapCoverage";
import { libImport, makeWorkspace } from "../helpers/inMemory";

const UI = {
	"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
	"src/App.tsx": [
		"export default function App() {",
		"  return (",
		"    <main>",
		'      <input data-testid="PromoCodeInput" />',
		'      <button data-testid="ApplyPromoButton" />',
		'      <span data-testid="Orphan" />',
		"    </main>",
		"  );",
		"}",
	].join("\n"),
};

const PAGE_OBJECT = {
	"e2e/HomePage.ts": [
		'import type { Locator } from "@playwright/test";',
		libImport("RootPageObject", "RootSelector", "Selector", "SelectorByRole"),
		"@RootSelector()",
		"export class HomePage extends RootPageObject {",
		'  @Selector("PromoCodeInput")',
		"  accessor Promo!: Locator;",
		'  @SelectorByRole("button", { name: "Apply" })',
		"  accessor Apply!: Locator;",
		'  @Selector("PromoCodeInpt")',
		"  accessor Typo!: Locator;",
		"  @Selector(dynamicId)",
		"  accessor Dyn!: Locator;",
		"}",
		"declare const dynamicId: string;",
	].join("\n"),
};

function report(extra: Record<string, string> = {}, options = {}) {
	return buildCoverageReport(
		makeWorkspace({ ...UI, ...PAGE_OBJECT, ...extra }),
		options,
	);
}

describe("buildCoverageReport", () => {
	const result = report();

	it("matches a test-id selector to its UI id", () => {
		const matched = result.matched.find(
			(entry) => entry.ui.id === "PromoCodeInput",
		);
		expect(matched?.selector.memberPath).toBe("HomePage.Promo");
		expect(matched?.confidence).toBe("exact");
	});

	it("lists ids that nothing selects, with a ready-to-paste suggestion", () => {
		const uncovered = result.uncoveredTestIds.map((entry) => entry.id);
		expect(uncovered).toContain("Orphan");
		expect(uncovered).toContain("ApplyPromoButton");
		const orphan = result.uncoveredTestIds.find(
			(entry) => entry.id === "Orphan",
		);
		expect(orphan?.suggestion).toBe('@Selector("Orphan")');
		expect(orphan?.occurrences).toHaveLength(1);
	});

	it("reports a typo'd selector as dead and suggests the real id", () => {
		const dead = result.deadSelectors.find(
			(entry) => entry.memberPath === "HomePage.Typo",
		);
		expect(dead).toBeDefined();
		expect(dead?.nearestTestIds).toContain("PromoCodeInput");
	});

	it("keeps role selectors out of the dead bucket", () => {
		expect(
			result.nonTestIdSelectors.map((entry) => entry.memberPath),
		).toContain("HomePage.Apply");
		expect(result.deadSelectors.map((entry) => entry.memberPath)).not.toContain(
			"HomePage.Apply",
		);
	});

	it("buckets a dynamic selector as unknown rather than dead", () => {
		expect(result.unknownSelectors.map((entry) => entry.memberPath)).toContain(
			"HomePage.Dyn",
		);
		expect(result.deadSelectors.map((entry) => entry.memberPath)).not.toContain(
			"HomePage.Dyn",
		);
	});

	it("excludes a bare @RootSelector() self scope from matching", () => {
		expect(
			result.matched.map((entry) => entry.selector.memberPath),
		).not.toContain("HomePage");
	});

	it("divides coverage by the matchable ids only", () => {
		expect(result.summary.matchableUiTestIds).toBe(3);
		expect(result.summary.coveredUiTestIds).toBe(1);
		expect(result.summary.coverage).toBeCloseTo(1 / 3);
		expect(result.summary.unknownTestIds).toBe(0);
	});

	it("warns that raw locator calls were not scanned", () => {
		expect(result.warnings.map((diagnostic) => diagnostic.code)).toContain(
			"raw-locators-disabled",
		);
	});
});

describe("buildCoverageReport — dynamic UI ids", () => {
	it("puts an unreadable attribute in unknownTestIds and out of the denominator", () => {
		const result = buildCoverageReport(
			makeWorkspace({
				...PAGE_OBJECT,
				"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
				"src/App.tsx": [
					"export default function App() {",
					"  const id = String(Math.random());",
					'  return <main><input data-testid="PromoCodeInput" /><span data-testid={id} /></main>;',
					"}",
				].join("\n"),
			}),
		);
		expect(result.summary.unknownTestIds).toBe(1);
		expect(result.summary.matchableUiTestIds).toBe(1);
		expect(result.summary.coverage).toBe(1);
		expect(result.unknownTestIds[0].value.kind).toBe("dynamic");
	});
});

describe("buildCoverageReport — raw locator sweep", () => {
	const SPEC = {
		"e2e/checkout.spec.ts": [
			'import { test } from "@playwright/test";',
			'test("x", async ({ page }) => {',
			'  await page.getByTestId("Orphan").click();',
			"});",
		].join("\n"),
	};

	it("leaves an id uncovered when the sweep is off", () => {
		const off = report(SPEC);
		expect(off.uncoveredTestIds.map((entry) => entry.id)).toContain("Orphan");
	});

	it("covers it once direct getByTestId calls are included", () => {
		const on = report(SPEC, { includeRawLocators: true });
		expect(on.uncoveredTestIds.map((entry) => entry.id)).not.toContain(
			"Orphan",
		);
		const matched = on.matched.find((entry) => entry.ui.id === "Orphan");
		expect(matched?.selector.defId).toBe("e2e/checkout.spec.ts");
		expect(on.warnings.map((diagnostic) => diagnostic.code)).not.toContain(
			"raw-locators-disabled",
		);
	});

	it("reads a regex literal argument as a pattern selector", () => {
		const on = report(
			{
				"e2e/regex.spec.ts": [
					'import { test } from "@playwright/test";',
					'test("x", async ({ page }) => {',
					"  await page.getByTestId(/Orph/).click();",
					"});",
				].join("\n"),
			},
			{ includeRawLocators: true },
		);
		const matched = on.matched.find(
			(entry) => entry.selector.defId === "e2e/regex.spec.ts",
		);
		expect(matched?.selector.kind).toBe("testIdPattern");
		expect(matched?.ui.id).toBe("Orphan");
	});
});

describe("buildCoverageReport — member paths", () => {
	it("names nested controls by the path that reaches them", () => {
		const result = buildCoverageReport(
			makeWorkspace({
				"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
				"src/App.tsx":
					'export default function App() { return <div data-testid="Nested" />; }',
				"e2e/Row.ts": [
					'import type { Locator } from "@playwright/test";',
					libImport("PageObject", "Selector"),
					"export class Row extends PageObject {",
					'  @Selector("Nested")',
					"  accessor Cell!: Locator;",
					"}",
				].join("\n"),
				"e2e/HomePage.ts": [
					libImport(
						"ListPageObject",
						"ListSelector",
						"RootPageObject",
						"RootSelector",
					),
					'import { Row } from "./Row";',
					'@RootSelector("Home")',
					"export class HomePage extends RootPageObject {",
					'  @ListSelector("Row_")',
					"  accessor Rows = new ListPageObject(Row);",
					"}",
				].join("\n"),
			}),
		);
		expect(result.matched.map((entry) => entry.selector.memberPath)).toContain(
			"HomePage.Rows[item].Cell",
		);
	});
});
