import { describe, expect, it } from "vitest";
import { buildCoverageReport } from "../../../analysis/coverage/mapCoverage";
import { hole, report } from "../helpers/coverageFixture";
import { libImport, makeWorkspace } from "../helpers/inMemory";

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

	it("extracts exact test ids from composed page-object locator strings", () => {
		const pageObject = {
			"e2e/ComposedPage.ts": [
				libImport("RootPageObject", "RootSelector"),
				"@RootSelector()",
				"export class ComposedPage extends RootPageObject {",
				"  cell(rowId: string) {",
				`    const row = \`[data-testid="ApplyPromoButton"][data-row-id="${hole("rowId")}"]\`;`,
				`    return this.$.locator(\`${hole("row")} [data-testid = 'Orphan']\`);`,
				"  }",
				"}",
			].join("\n"),
		};
		const off = report(pageObject);
		const on = report(pageObject, { includeRawLocators: true });

		expect(off.uncoveredTestIds.map((entry) => entry.id)).toEqual(
			expect.arrayContaining(["ApplyPromoButton", "Orphan"]),
		);
		expect(on.uncoveredTestIds.map((entry) => entry.id)).not.toEqual(
			expect.arrayContaining(["ApplyPromoButton", "Orphan"]),
		);
		expect(
			on.matched
				.filter((entry) =>
					["ApplyPromoButton", "Orphan"].includes(entry.ui.id ?? ""),
				)
				.map((entry) => entry.selector.origin),
		).toEqual(["raw", "raw"]);
	});

	it("does not invent an id from a dynamic locator interpolation", () => {
		const result = report(
			{
				"e2e/DynamicPage.ts": [
					libImport("RootPageObject", "RootSelector"),
					"@RootSelector()",
					"export class DynamicPage extends RootPageObject {",
					"  cell(id: string) {",
					`    return this.$.locator(\`[data-testid="${hole("id")}"]\`);`,
					"  }",
					"}",
				].join("\n"),
			},
			{ includeRawLocators: true },
		);

		expect(result.uncoveredTestIds.map((entry) => entry.id)).toContain(
			"Orphan",
		);
		expect(result.matched.some((entry) => entry.ui.id === "Orphan")).toBe(
			false,
		);
	});

	it("uses the resolved custom test-id attribute", () => {
		const result = buildCoverageReport(
			makeWorkspace({
				"src/App.tsx":
					'export function App() { return <div data-tid="Cell" />; }',
				"e2e/CustomPage.ts": [
					libImport("RootPageObject", "RootSelector"),
					"@RootSelector()",
					"export class CustomPage extends RootPageObject {",
					`  cell() { return this.$.locator('[data-tid="Cell"]'); }`,
					"}",
				].join("\n"),
			}),
			{ attribute: "data-tid", includeRawLocators: true },
		);

		expect(result.uncoveredTestIds).toEqual([]);
		expect(result.matched[0]?.ui.id).toBe("Cell");
	});
});

/**
 * The field failure this whole cluster exists for.
 *
 * One element whose test id is a bare template hole compiles to `^.+$`. Matched like
 * any other pattern it covered every selector in the repository — about 1340 of
 * them — reported a healthy score, and emptied the dead-selector list, so the
 * report was simultaneously perfect and useless.
 */
describe("buildCoverageReport — a pattern that matches everything", () => {
	const CATCH_ALL = {
		"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
		"src/App.tsx": [
			"export default function App() {",
			"  const id = String(Math.random());",
			`  return <main><div data-testid={\`${hole("id")}\`} /></main>;`,
			"}",
		].join("\n"),
		"e2e/WidePage.ts": [
			'import type { Locator } from "@playwright/test";',
			libImport("RootPageObject", "RootSelector", "Selector"),
			"@RootSelector()",
			"export class WidePage extends RootPageObject {",
			'  @Selector("Alpha")',
			"  accessor A!: Locator;",
			'  @Selector("Beta")',
			"  accessor B!: Locator;",
			'  @Selector("Gamma")',
			"  accessor C!: Locator;",
			"}",
		].join("\n"),
	};

	const result = buildCoverageReport(makeWorkspace(CATCH_ALL));

	it("fabricates no matches at all", () => {
		expect(result.matched).toEqual([]);
		expect(result.summary.matchableUiTestIds).toBe(0);
		expect(result.summary.catchAllTestIds).toBe(1);
	});

	it("still reports the three selectors that really do match nothing", () => {
		expect(
			result.deadSelectors.map((entry) => entry.memberPath).sort(),
		).toEqual(["WidePage.A", "WidePage.B", "WidePage.C"]);
	});

	it("keeps the quarantined occurrence, labelled with why", () => {
		const quarantined = result.unknownTestIds.filter(
			(entry) => entry.reason === "unanchored-pattern",
		);
		expect(quarantined).toHaveLength(1);
		expect(quarantined[0].patternSource).toBe("^.+$");
		expect(quarantined[0].occurrence.file).toBe("src/App.tsx");
	});

	it("says out loud that it excluded it, with a place to look", () => {
		const warning = result.warnings.find(
			(diagnostic) => diagnostic.code === "unanchored-testid-pattern",
		);
		expect(warning?.severity).toBe("warning");
		expect(warning?.message).toContain("src/App.tsx");
		expect(warning?.loc?.file).toBe("src/App.tsx");
	});

	it("refuses to score a comparison with no denominator", () => {
		expect(result.summary.coverage).toBeNull();
		expect(result.warnings.map((entry) => entry.code)).toContain(
			"no-matchable-testids",
		);
	});
});

describe("buildCoverageReport — a selector that matches everything", () => {
	it("reports an empty list pattern as unknown, not as total coverage", () => {
		const result = report({
			"e2e/EverythingPage.ts": [
				libImport("ListRootSelector", "RootPageObject"),
				'@ListRootSelector("")',
				"export class EverythingPage extends RootPageObject {}",
			].join("\n"),
		});
		expect(result.unknownSelectors).toContainEqual(
			expect.objectContaining({
				memberPath: "EverythingPage",
				reason: "unanchored-pattern",
			}),
		);
		expect(
			result.matched.map((entry) => entry.selector.memberPath),
		).not.toContain("EverythingPage");
	});
});

/**
 * The other half of the contradiction: the same report listed an id under
 * `unknownTestIds` because it could not read the expression, and listed the
 * selector for that id under `deadSelectors` because it had not matched.
 */
describe("buildCoverageReport — literals inside runtime-built ids", () => {
	const RUNTIME = {
		"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
		"src/App.tsx": [
			"declare function formatTID(name: string, index: number): string;",
			"export default function App() {",
			"  return <main><li data-testid={formatTID(RoomsCategoryItem, 1)} /></main>;",
			"}",
			"declare const RoomsCategoryItem: string;",
		].join("\n"),
	};

	const pageObject = (id: string) => ({
		"e2e/RoomsPage.ts": [
			'import type { Locator } from "@playwright/test";',
			libImport("RootPageObject", "RootSelector", "Selector"),
			"@RootSelector()",
			"export class RoomsPage extends RootPageObject {",
			`  @Selector(${JSON.stringify(id)})`,
			"  accessor Item!: Locator;",
			"}",
		].join("\n"),
	});

	it("reports the selector as unreadable rather than dead", () => {
		const result = buildCoverageReport(
			makeWorkspace({ ...RUNTIME, ...pageObject("RoomsCategoryItem") }),
		);
		expect(result.deadSelectors).toEqual([]);
		const unknown = result.unknownSelectors.find(
			(entry) => entry.memberPath === "RoomsPage.Item",
		);
		expect(unknown?.reason).toBe("dynamic-testid-expression");
		expect(unknown?.evidence?.raw).toContain("formatTID");
		expect(unknown?.evidence?.loc?.file).toBe("src/App.tsx");
	});

	it("does not let a two-character literal buy a selector out of dead", () => {
		const result = buildCoverageReport(
			makeWorkspace({ ...RUNTIME, ...pageObject("ID") }),
		);
		expect(result.deadSelectors.map((entry) => entry.memberPath)).toEqual([
			"RoomsPage.Item",
		]);
	});
});

describe("buildCoverageReport — no denominator", () => {
	it("returns null coverage and names both causes when the attribute is wrong", () => {
		const result = report({}, { attribute: "data-qa" });
		expect(result.summary.matchableUiTestIds).toBe(0);
		expect(result.summary.coverage).toBeNull();
		const warning = result.warnings.find(
			(entry) => entry.code === "no-matchable-testids",
		);
		expect(warning?.severity).toBe("warning");
		expect(warning?.message).toContain("data-qa");
		expect(warning?.message).toContain("different attribute");
		expect(warning?.message).toContain("scanned sources");
		expect(warning?.data?.attributeSource).toBe("param");
	});

	it("reports how many static ids the selectors were compared against", () => {
		expect(report().summary.staticUiIdsCompared).toBe(3);
		expect(
			report({}, { attribute: "data-qa" }).summary.staticUiIdsCompared,
		).toBe(0);
	});
});

/**
 * The old sweep looked for `getByTestId` in `*.spec.ts` and nothing else, so a
 * repository whose tests are named `checkout.e2e.ts`, or that reaches rows with
 * `filterByHasTestId`, got told its ids were unused.
 */
describe("buildCoverageReport — widened direct-locator sweep", () => {
	const on = { includeRawLocators: true };

	it("finds a call in a file that is not named like a spec", () => {
		const result = report(
			{
				"e2e/helpers.ts": [
					"declare const list: { getItemByTestId(id: string): unknown };",
					'export const first = () => list.getItemByTestId("Orphan");',
				].join("\n"),
			},
			on,
		);
		expect(result.uncoveredTestIds.map((entry) => entry.id)).not.toContain(
			"Orphan",
		);
		const match = result.matched.find((entry) => entry.ui.id === "Orphan");
		expect(match?.selector.defId).toBe("e2e/helpers.ts");
		expect(match?.selector.origin).toBe("raw");
	});

	it("reads the other three call names this library exposes", () => {
		const result = report(
			{
				"e2e/filters.ts": [
					"declare const list: { filterByHasTestId(id: RegExp): unknown };",
					"export const rows = () => list.filterByHasTestId(/Orph/);",
				].join("\n"),
			},
			on,
		);
		const match = result.matched.find(
			(entry) => entry.selector.defId === "e2e/filters.ts",
		);
		expect(match?.selector.kind).toBe("testIdPattern");
		expect(match?.ui.id).toBe("Orphan");
	});

	it("turns a template-literal argument into a pattern instead of dropping it", () => {
		const result = report(
			{
				"e2e/template.ts": [
					"declare const page: { getByTestId(id: string): unknown };",
					"declare const i: number;",
					`export const row = () => page.getByTestId(\`Promo${hole("i")}\`);`,
				].join("\n"),
			},
			on,
		);
		const match = result.matched.find(
			(entry) => entry.selector.defId === "e2e/template.ts",
		);
		expect(match?.selector.kind).toBe("testIdPattern");
		expect(match?.ui.id).toBe("PromoCodeInput");
	});

	it("reports an unreadable argument as unknown rather than saying nothing", () => {
		const result = report(
			{
				"e2e/dynamic.ts": [
					"declare const page: { getByTestId(id: string): unknown };",
					"declare function buildId(): string;",
					"export const x = () => page.getByTestId(buildId());",
				].join("\n"),
			},
			on,
		);
		expect(result.unknownSelectors).toContainEqual(
			expect.objectContaining({ defId: "e2e/dynamic.ts", origin: "raw" }),
		);
	});

	it("counts the sweep's own contribution", () => {
		const files = {
			"e2e/helpers.ts": [
				"declare const list: { getItemByTestId(id: string): unknown };",
				'export const first = () => list.getItemByTestId("Orphan");',
			].join("\n"),
		};
		expect(report(files, on).summary.rawSelectors).toBe(1);
		expect(report(files).summary.rawSelectors).toBe(0);
	});
});
