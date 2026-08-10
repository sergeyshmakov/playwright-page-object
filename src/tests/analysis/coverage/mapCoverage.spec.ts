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

/** A template hole in fixture *source*, assembled so it is not one here. */
const hole = (name: string): string => `\${${name}}`;

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

	// The caveat is evidence, not decoration: a run that saw the whole UI must
	// not hedge, or the flag stops meaning anything where it does appear.
	it("does not caveat a dead selector when the scan saw everything", () => {
		expect(result.scope.externalComponentTags).toBe(0);
		const dead = result.deadSelectors.find(
			(entry) => entry.memberPath === "HomePage.Typo",
		);
		expect(dead?.scopeIncomplete).toBeUndefined();
		expect(result.summary.deadSelectors).toBe(result.deadSelectors.length);
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
		expect(result.unknownTestIds[0]).toMatchObject({
			reason: "dynamic-value",
		});
		expect(result.unknownTestIds[0].occurrence.value.kind).toBe("dynamic");
	});
});

/**
 * A test id written on a component tag is a prop, and a prop only reaches the
 * DOM if the component forwards it. Counting it as rendered invents coverage;
 * calling the selector that matches it dead invents a bug. Both are worse than
 * saying "unproven", which is what the report does.
 */
describe("buildCoverageReport — ids written on a component tag", () => {
	const UNFORWARDED = {
		"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
		"src/App.tsx": [
			'import Card from "./Card";',
			"export default function App() {",
			'  return <main><Card data-testid="Ghost" /></main>;',
			"}",
		].join("\n"),
		"src/Card.tsx": [
			"export default function Card(props: { children?: unknown }) {",
			"  return <div>{props.children as never}</div>;",
			"}",
		].join("\n"),
		"e2e/GhostPage.ts": [
			'import type { Locator } from "@playwright/test";',
			libImport("RootPageObject", "RootSelector", "Selector"),
			"@RootSelector()",
			"export class GhostPage extends RootPageObject {",
			'  @Selector("Ghost")',
			"  accessor Ghost!: Locator;",
			"}",
		].join("\n"),
	};

	const result = buildCoverageReport(makeWorkspace(UNFORWARDED));

	it("does not count an unforwarded prop as a rendered, matched id", () => {
		expect(result.matched).toEqual([]);
		expect(result.summary.matchableUiTestIds).toBe(0);
		expect(result.uncoveredTestIds).toEqual([]);
	});

	it("reports the selector as unknown rather than dead", () => {
		expect(result.deadSelectors).toEqual([]);
		expect(result.unknownSelectors).toContainEqual(
			expect.objectContaining({
				memberPath: "GhostPage.Ghost",
				reason: "forwarding-unproven",
			}),
		);
	});

	it("keeps the occurrence in the report instead of dropping it", () => {
		expect(result.summary.unknownTestIds).toBe(1);
		expect(result.unknownTestIds[0]).toMatchObject({
			reason: "forwarding-unproven",
			occurrence: { tag: "Card", reach: "component-prop" },
		});
		expect(result.warnings.map((diagnostic) => diagnostic.code)).toContain(
			"testid-forwarding-unproven",
		);
	});

	it("counts the id normally once forwarding is proven", () => {
		const forwarded = buildCoverageReport(
			makeWorkspace({
				...UNFORWARDED,
				"src/Card.tsx": [
					"export default function Card(props: Record<string, unknown>) {",
					"  return <div {...props} />;",
					"}",
				].join("\n"),
			}),
		);
		expect(forwarded.summary.matchableUiTestIds).toBe(1);
		expect(forwarded.matched.map((entry) => entry.ui.id)).toEqual(["Ghost"]);
		expect(forwarded.deadSelectors).toEqual([]);
		expect(forwarded.unknownSelectors).toEqual([]);
	});

	// A lowercase namespace does not make `<icons.Card>` a host element — JSX
	// reads any dotted tag out of scope — so the id on it is still a prop nobody
	// has proven reaches the DOM.
	it("treats a dotted tag with a lowercase namespace the same way", () => {
		const namespaced = buildCoverageReport(
			makeWorkspace({
				...UNFORWARDED,
				"src/icons.tsx": [
					"export function Card(props: { children?: unknown }) {",
					"  return <div>{props.children as never}</div>;",
					"}",
				].join("\n"),
				"src/App.tsx": [
					'import * as icons from "./icons";',
					"export default function App() {",
					'  return <main><icons.Card data-testid="Ghost" /></main>;',
					"}",
				].join("\n"),
			}),
		);
		expect(namespaced.matched).toEqual([]);
		expect(namespaced.summary.matchableUiTestIds).toBe(0);
		expect(namespaced.unknownSelectors).toContainEqual(
			expect.objectContaining({
				memberPath: "GhostPage.Ghost",
				reason: "forwarding-unproven",
			}),
		);
		expect(namespaced.unknownTestIds[0]).toMatchObject({
			reason: "forwarding-unproven",
			occurrence: { tag: "icons.Card", reach: "component-prop" },
		});
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

describe("buildCoverageReport — assuming forwarding", () => {
	const FILES = {
		"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
		"src/App.tsx": [
			'import Card from "./Card";',
			"export default function App() {",
			'  return <main><Card data-testid="Ghost" /></main>;',
			"}",
		].join("\n"),
		"src/Card.tsx": [
			"export default function Card(props: { children?: unknown }) {",
			"  return <div>{props.children as never}</div>;",
			"}",
		].join("\n"),
		"e2e/GhostPage.ts": [
			'import type { Locator } from "@playwright/test";',
			libImport("RootPageObject", "RootSelector", "Selector"),
			"@RootSelector()",
			"export class GhostPage extends RootPageObject {",
			'  @Selector("Ghost")',
			"  accessor Ghost!: Locator;",
			"}",
		].join("\n"),
	};

	it("promotes the prop id and labels every place the assumption shows", () => {
		const result = buildCoverageReport(makeWorkspace(FILES), {
			assumeForwarded: true,
		});
		expect(result.summary.matchableUiTestIds).toBe(1);
		expect(result.summary.assumedForwardedTestIds).toBe(1);
		expect(result.matched).toHaveLength(1);
		expect(result.matched[0].forwarding).toBe("assumed");
		expect(result.unknownSelectors).toEqual([]);
		const warning = result.warnings.find(
			(entry) => entry.code === "forwarding-assumed",
		);
		expect(warning?.severity).toBe("warning");
	});

	/**
	 * A promoted id belongs to exactly one bucket.
	 *
	 * `UnknownTestId` means "coverage could not treat this as rendered", and the
	 * whole point of the flag is that it now can. Leaving the occurrence under
	 * `forwarding-unproven` as well would contradict that contract and count the
	 * id twice in `summary.uiTestIds`, which is `matchable + unknown`.
	 */
	it("keeps a promoted prop id out of the unknown bucket", () => {
		const result = buildCoverageReport(makeWorkspace(FILES), {
			assumeForwarded: true,
		});
		expect(
			result.unknownTestIds.filter(
				(entry) => entry.reason === "forwarding-unproven",
			),
		).toEqual([]);
		expect(result.summary.unknownTestIds).toBe(result.unknownTestIds.length);
		expect(result.summary.uiTestIds).toBe(
			result.summary.matchableUiTestIds + result.summary.unknownTestIds,
		);
	});

	it("does report it as unproven when the flag is off", () => {
		const result = buildCoverageReport(makeWorkspace(FILES));
		expect(result.unknownTestIds.map((entry) => entry.reason)).toContain(
			"forwarding-unproven",
		);
		expect(result.summary.matchableUiTestIds).toBe(0);
	});

	it("says nothing about assuming anything when the flag is off", () => {
		const result = buildCoverageReport(makeWorkspace(FILES));
		expect(result.summary.assumedForwardedTestIds).toBeUndefined();
		expect(result.warnings.map((entry) => entry.code)).not.toContain(
			"forwarding-assumed",
		);
	});

	it("suggests the flag once enough selectors land in the unproven bucket", () => {
		const many = {
			...FILES,
			"src/App.tsx": [
				'import Card from "./Card";',
				"export default function App() {",
				"  return (",
				"    <main>",
				'      <Card data-testid="Ghost" />',
				'      <Card data-testid="Phantom" />',
				'      <Card data-testid="Wraith" />',
				"    </main>",
				"  );",
				"}",
			].join("\n"),
			"e2e/GhostPage.ts": [
				'import type { Locator } from "@playwright/test";',
				libImport("RootPageObject", "RootSelector", "Selector"),
				"@RootSelector()",
				"export class GhostPage extends RootPageObject {",
				'  @Selector("Ghost")',
				"  accessor A!: Locator;",
				'  @Selector("Phantom")',
				"  accessor B!: Locator;",
				'  @Selector("Wraith")',
				"  accessor C!: Locator;",
				"}",
			].join("\n"),
		};
		const result = buildCoverageReport(makeWorkspace(many));
		const widespread = result.warnings.find(
			(entry) => entry.code === "forwarding-unproven-widespread",
		);
		expect(widespread?.severity).toBe("info");
		expect(widespread?.data?.unproven).toBe(3);
	});
});

/**
 * A monorepo pointed at one app renders half its UI from sibling packages. Test
 * ids in those are invisible here, so every selector for one reads as dead —
 * and the report used to say so without a word about the scope it was reading.
 */
describe("buildCoverageReport — component tags from outside the scan", () => {
	const EXTERNAL = {
		"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
		"src/App.tsx": [
			'import { Gapped } from "@design/ui";',
			"export default function App() {",
			'  return <main><Gapped /><div data-testid="Local" /></main>;',
			"}",
		].join("\n"),
	};

	const pageObject = (id: string) => ({
		"e2e/AppPage.ts": [
			'import type { Locator } from "@playwright/test";',
			libImport("RootPageObject", "RootSelector", "Selector"),
			"@RootSelector()",
			"export class AppPage extends RootPageObject {",
			`  @Selector(${JSON.stringify(id)})`,
			"  accessor Thing!: Locator;",
			"}",
		].join("\n"),
	});

	it("counts the boundary and names the module", () => {
		const result = buildCoverageReport(
			makeWorkspace({ ...EXTERNAL, ...pageObject("Local") }),
		);
		expect(result.scope.externalComponentModules).toEqual(["@design/ui"]);
		expect(result.scope.externalComponentTags).toBe(1);
		expect(result.scope.uiFilesScanned).toBeGreaterThan(0);
		expect(result.scope.pageObjectFilesScanned).toBeGreaterThan(0);
	});

	it("stays informational while nothing looks broken", () => {
		const result = buildCoverageReport(
			makeWorkspace({ ...EXTERNAL, ...pageObject("Local") }),
		);
		expect(result.deadSelectors).toEqual([]);
		expect(
			result.warnings.find((entry) => entry.code === "ui-scope-incomplete")
				?.severity,
		).toBe("info");
	});

	it("becomes a warning the moment a selector reads as dead", () => {
		const result = buildCoverageReport(
			makeWorkspace({ ...EXTERNAL, ...pageObject("InsideGapped") }),
		);
		expect(result.deadSelectors).toHaveLength(1);
		const scope = result.warnings.find(
			(entry) => entry.code === "ui-scope-incomplete",
		);
		expect(scope?.severity).toBe("warning");
		expect(scope?.message).toContain("@design/ui");
		expect(scope?.message).not.toContain("monorepo");
	});

	// The global warning is the remediation; the flag is what an agent reading
	// one entry — or a list `limit` cut short — actually has in front of it.
	it("carries the caveat on every dead entry, typo discriminator intact", () => {
		const result = buildCoverageReport(
			makeWorkspace({
				...EXTERNAL,
				"e2e/AppPage.ts": [
					'import type { Locator } from "@playwright/test";',
					libImport("RootPageObject", "RootSelector", "Selector"),
					"@RootSelector()",
					"export class AppPage extends RootPageObject {",
					'  @Selector("InsideGapped")',
					"  accessor Hidden!: Locator;",
					'  @Selector("Locl")',
					"  accessor Typo!: Locator;",
					"}",
				].join("\n"),
			}),
		);

		expect(result.deadSelectors).toHaveLength(2);
		expect(result.summary.deadSelectors).toBe(2);
		expect(
			result.deadSelectors.every((entry) => entry.scopeIncomplete === true),
			"the scan is what is incomplete, so the caveat is uniform",
		).toBe(true);

		// Same flag, two different readings, and the discriminator is the one
		// piece of per-entry evidence that is real.
		const byPath = (memberPath: string) =>
			result.deadSelectors.find((entry) => entry.memberPath === memberPath);
		expect(byPath("AppPage.Hidden")?.nearestTestIds).toEqual([]);
		expect(byPath("AppPage.Typo")?.nearestTestIds).toContain("Local");

		const scope = result.warnings.find(
			(entry) => entry.code === "ui-scope-incomplete",
		);
		expect(scope?.message).toContain("scopeIncomplete");
	});

	it("does not count a relative import as a boundary", () => {
		const result = buildCoverageReport(
			makeWorkspace({
				...EXTERNAL,
				"src/App.tsx": [
					'import { Gapped } from "./Gapped";',
					"export default function App() {",
					'  return <main><Gapped /><div data-testid="Local" /></main>;',
					"}",
				].join("\n"),
				"src/Gapped.tsx":
					'export function Gapped() { return <b data-testid="Inner" />; }',
				...pageObject("Local"),
			}),
		);
		expect(result.scope.externalComponentTags).toBe(0);
		expect(result.warnings.map((entry) => entry.code)).not.toContain(
			"ui-scope-incomplete",
		);
	});
});

/**
 * The field failure, end to end.
 *
 * One list item writes both ids through a ternary interpolated at the head of a
 * template. Read as a single opaque hole the line compiles to
 * `^.+BedListItem_.+$`, which no probe reconciles with either selector, so a
 * page object that works was reported as two dead selectors.
 */
describe("buildCoverageReport — a ternary inside a template", () => {
	const bedId = (branch: string): string =>
		["`", hole(branch), "BedListItem_", hole("bedIndex"), "`"].join("");

	const bedList = (branch: string): Record<string, string> => ({
		"src/App.tsx": [
			"export default function App(props: { beds: string[]; label: string; isAdditional: boolean }) {",
			"  const { beds, label, isAdditional } = props;",
			"  void label;",
			"  return (",
			'    <ul data-testid="BedList">',
			"      {beds.map((bed, bedIndex) => (",
			`        <li key={bed} data-testid={${bedId(branch)}}>`,
			'          <span data-testid="BedName">{bed}</span>',
			"        </li>",
			"      ))}",
			"    </ul>",
			"  );",
			"}",
			"void isAdditional;",
		].join("\n"),
		"e2e/BedRow.ts": [
			'import type { Locator } from "@playwright/test";',
			libImport("PageObject", "Selector"),
			"export class BedRow extends PageObject {",
			'  @Selector("BedName")',
			"  accessor Name!: Locator;",
			"}",
		].join("\n"),
	});

	const pageObject = (...masks: string[]): Record<string, string> => ({
		"e2e/BedsPage.ts": [
			libImport(
				"ListPageObject",
				"ListSelector",
				"RootPageObject",
				"RootSelector",
			),
			'import { BedRow } from "./BedRow";',
			'@RootSelector("BedList")',
			"export class BedsPage extends RootPageObject {",
			...masks.flatMap((mask, index) => [
				`  @ListSelector("${mask}")`,
				`  accessor Beds${index} = new ListPageObject(BedRow);`,
			]),
			"}",
		].join("\n"),
	});

	it("credits both branches of a static ternary, and calls neither dead", () => {
		const result = buildCoverageReport(
			makeWorkspace({
				...bedList('isAdditional ? "Additional" : "Main"'),
				...pageObject("MainBedListItem", "AdditionalBedListItem"),
			}),
		);

		const dead = result.deadSelectors.map((entry) => entry.memberPath);
		expect(dead).not.toContain("BedsPage.Beds0");
		expect(dead).not.toContain("BedsPage.Beds1");

		const byPath = (memberPath: string) =>
			result.matched.find((entry) => entry.selector.memberPath === memberPath);
		expect(byPath("BedsPage.Beds0")?.ui.patternSource).toBe(
			"^MainBedListItem_.+$",
		);
		expect(byPath("BedsPage.Beds1")?.ui.patternSource).toBe(
			"^AdditionalBedListItem_.+$",
		);
		expect(byPath("BedsPage.Beds0")?.confidence).toBe("probe");
	});

	// The other route: one branch is not a literal, so the hole stays a `.+` and
	// the template still yields an anchored pattern rather than a catch-all.
	it("still anchors the pattern when a branch is not static", () => {
		const result = buildCoverageReport(
			makeWorkspace({
				...bedList('isAdditional ? label : "Main"'),
				...pageObject("BedListItem_"),
			}),
		);

		expect(result.matched.map((entry) => entry.ui.patternSource)).toContain(
			"^.+BedListItem_.+$",
		);
		expect(result.deadSelectors.map((entry) => entry.memberPath)).not.toContain(
			"BedsPage.Beds0",
		);
		// Quarantining it would have dropped the id and made the selector dead.
		expect(result.summary.catchAllTestIds).toBe(0);
	});
});

/**
 * The report used to contradict itself at the top: `coverage: null` and a
 * `no-matchable-testids` warning saying nothing could be compared, next to a
 * `deadSelectors` list holding every working selector in the suite — 1454 of
 * them in the field. An agent that skips warnings reads a catastrophe.
 */
describe("buildCoverageReport — a scan that found no test id at all", () => {
	const WRONG_ATTRIBUTE = {
		"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
		"src/App.tsx": [
			"export default function App() {",
			'  return <main data-tid="AppRoot"><input data-tid="EmailInput" /></main>;',
			"}",
		].join("\n"),
		"e2e/LoginPage.ts": [
			'import type { Locator } from "@playwright/test";',
			libImport("RootPageObject", "RootSelector", "Selector"),
			'@RootSelector("AppRoot")',
			"export class LoginPage extends RootPageObject {",
			'  @Selector("EmailInput")',
			"  accessor Email!: Locator;",
			"}",
		].join("\n"),
	};

	// Reads `data-testid` against sources that write `data-tid`.
	const result = buildCoverageReport(makeWorkspace(WRONG_ATTRIBUTE));

	it("calls every selector unverifiable instead of dead", () => {
		expect(result.summary.matchableUiTestIds).toBe(0);
		expect(result.summary.coverage).toBeNull();
		expect(result.deadSelectors).toEqual([]);
		expect(result.summary.deadSelectors).toBe(0);

		const reasons = result.unknownSelectors.map((entry) => entry.reason);
		expect(reasons).toEqual(["no-ui-evidence", "no-ui-evidence"]);
		expect(result.summary.unknownSelectors).toBe(2);
	});

	it("keeps the selector total whole across the buckets", () => {
		// Nothing vanished in the re-bucketing: every selector is still counted
		// exactly once, which is what makes the zero above readable.
		expect(
			result.matched.length +
				result.unknownSelectors.length +
				result.deadSelectors.length,
		).toBe(result.summary.testIdSelectors);
	});

	it("names the remedy and where the selectors went", () => {
		const warning = result.warnings.find(
			(entry) => entry.code === "no-matchable-testids",
		);
		expect(warning?.message).toContain("no-ui-evidence");
		expect(warning?.message).toContain("data-testid");
	});

	// The whole point of narrowing the condition: a repository the scan can read
	// must still get dead detection.
	it("leaves dead detection alone once the attribute is right", () => {
		const right = buildCoverageReport(makeWorkspace(WRONG_ATTRIBUTE), {
			attribute: "data-tid",
		});
		expect(right.summary.matchableUiTestIds).toBe(2);
		expect(right.unknownSelectors).toEqual([]);

		const typo = buildCoverageReport(
			makeWorkspace({
				...WRONG_ATTRIBUTE,
				"e2e/LoginPage.ts": [
					'import type { Locator } from "@playwright/test";',
					libImport("RootPageObject", "RootSelector", "Selector"),
					'@RootSelector("AppRoot")',
					"export class LoginPage extends RootPageObject {",
					'  @Selector("EmailInpt")',
					"  accessor Email!: Locator;",
					"}",
				].join("\n"),
			}),
			{ attribute: "data-tid" },
		);
		expect(typo.deadSelectors.map((entry) => entry.memberPath)).toEqual([
			"LoginPage.Email",
		]);
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
