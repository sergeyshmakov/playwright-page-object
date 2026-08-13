import { describe, expect, it } from "vitest";
import {
	buildCoverageReport,
	scopeMessage,
} from "../../../analysis/coverage/mapCoverage";
import { hole, report } from "../helpers/coverageFixture";
import { libImport, makeWorkspace } from "../helpers/inMemory";

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

/**
 * A match is made against the ids the scan proved reach the DOM, which is
 * right, and on its own misleads: the same id can also be written as a
 * component prop nobody proved. On a production repository that is exactly
 * where a broken selector hid — an entry came back `confidence: "exact"`
 * against an unrelated component while the site the page object was written
 * for was an unproven prop, and the report looked clean.
 */
describe("buildCoverageReport — an id that is both rendered and forwarded", () => {
	const files = {
		"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
		// One real element with the id, and one component tag carrying it as a
		// prop that nothing proves is forwarded.
		"src/App.tsx": [
			'import { Card } from "./Card";',
			"export default function App() {",
			'  return <main><span data-testid="Info" /><Card data-testid="Info" /></main>;',
			"}",
		].join("\n"),
		"src/Card.tsx": [
			"export function Card(props: { title?: string }) {",
			"  return <section>{props.title}</section>;",
			"}",
		].join("\n"),
		"e2e/AppPage.ts": [
			'import type { Locator } from "@playwright/test";',
			libImport("RootPageObject", "RootSelector", "Selector"),
			"@RootSelector()",
			"export class AppPage extends RootPageObject {",
			'  @Selector("Info")',
			"  accessor Info!: Locator;",
			"}",
		].join("\n"),
	};

	it("says the id has unproven sites the match did not consider", () => {
		const result = buildCoverageReport(makeWorkspace(files));
		const entry = result.matched.find(
			(one) => one.selector.memberPath === "AppPage.Info",
		);

		expect(entry?.confidence).toBe("exact");
		// The match itself is sound: it names the element that provably renders.
		expect(entry?.ui.occurrences[0]?.file).toBe("src/App.tsx");
		// And it no longer hides the other half of the story.
		expect(entry?.unprovenOccurrences).toBe(1);
		expect(entry?.unprovenAt?.file).toBe("src/App.tsx");
	});

	it("says nothing when every occurrence of the id is proven", () => {
		const result = buildCoverageReport(
			makeWorkspace({
				...files,
				"src/App.tsx": [
					"export default function App() {",
					'  return <main><span data-testid="Info" /></main>;',
					"}",
				].join("\n"),
			}),
		);
		const entry = result.matched.find(
			(one) => one.selector.memberPath === "AppPage.Info",
		);
		expect(entry?.unprovenOccurrences).toBeUndefined();
	});
});

/**
 * `pageObjectFilesScanned` counted the include list, not the run. Scoping to a
 * class pulls in every page object nested under it, so a report drawn from
 * several files reported one — and the scope-narrowed warning said so in prose.
 */
describe("buildCoverageReport — how many page-object files contributed", () => {
	it("counts the files the selectors came from", () => {
		const result = buildCoverageReport(
			makeWorkspace({
				"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
				"src/App.tsx": [
					"export default function App() {",
					'  return <main><span data-testid="Row" /><b data-testid="Cell" /></main>;',
					"}",
				].join("\n"),
				"e2e/Row.ts": [
					'import type { Locator } from "@playwright/test";',
					libImport("PageObject", "Selector"),
					"export class Row extends PageObject {",
					'  @Selector("Cell")',
					"  accessor Cell!: Locator;",
					"}",
				].join("\n"),
				"e2e/HomePage.ts": [
					libImport("RootPageObject", "RootSelector", "Selector"),
					'import { Row } from "./Row";',
					"@RootSelector()",
					"export class HomePage extends RootPageObject {",
					'  @Selector("Row")',
					"  accessor Row = new Row();",
					"}",
				].join("\n"),
			}),
		);

		// Two files declare the selectors this report matched, and it says two.
		expect(result.scope.pageObjectFilesScanned).toBe(2);
	});
});

/**
 * Deciding a module is *linked* means resolving a real `node_modules` symlink on
 * disk, which an in-memory fixture cannot produce — so the message is exercised
 * directly. It is the sentence that tells a reader where to re-root, and it was
 * asserting an in-repo source for every module it had just named.
 */
describe("scopeMessage — who is claimed to have sources here", () => {
	const BASE = {
		tags: 40,
		modules: ["@design/ui", "@sentry/react"],
		moduleCount: 2,
		deadCount: 3,
	};

	it("names only the linked modules, and accounts for the rest", () => {
		const message = scopeMessage({
			...BASE,
			linkedModules: ["@design/ui"],
			linkedCount: 1,
			sourceRoot: "C:/repo",
		});

		expect(message).toContain("1 of them (@design/ui)");
		expect(message).toContain('rooted at "C:/repo"');
		// The claim that must not spread to the installed package.
		expect(message).not.toContain("@sentry/react) resolve through");
		expect(message).toContain(
			"The other 1 resolve to installed packages or do not resolve at all",
		);
	});

	it("promises no re-rooting when nothing is linked", () => {
		const message = scopeMessage({
			...BASE,
			linkedModules: [],
			linkedCount: 0,
		});

		expect(message).not.toContain("node_modules link");
		expect(message).not.toContain("re-run with the analysis rooted");
		expect(message).toContain("They resolve to installed packages");
	});

	it("does not present a capped list as the whole set", () => {
		const ten = Array.from({ length: 10 }, (_, index) => `@pkg/m${index}`);
		const message = scopeMessage({
			tags: 500,
			modules: ten,
			moduleCount: 44,
			linkedModules: [],
			linkedCount: 0,
			deadCount: 0,
		});

		expect(message).toContain("44 module(s)");
		expect(message).toContain("first 10 by name");
	});

	it("says nothing about a sample when the list is complete", () => {
		const message = scopeMessage({
			...BASE,
			linkedModules: [],
			linkedCount: 0,
		});

		expect(message).toContain("2 module(s)");
		expect(message).not.toContain("first 2 by name");
	});
});

describe("buildCoverageReport - a scoped page-object side and raw locators", () => {
	/**
	 * `poInclude` narrows whose selectors are being audited. It does not narrow
	 * what counts as evidence that an id is used - and scoping the raw sweep to
	 * the page-object file made `includeRawLocators` nearly inert on a scoped
	 * call, because a page-object file rarely contains `page.getByTestId`. The
	 * report then said an id was uncovered while a spec selected it by name.
	 */
	const files = {
		"e2e/promo.spec.ts": [
			'import { test } from "@playwright/test";',
			'test("promo", async ({ page }) => {',
			'  await page.getByTestId("Orphan").click();',
			"});",
		].join("\n"),
	};

	it("counts a raw locator in a spec file the scope excludes", () => {
		const scoped = report(files, {
			poInclude: ["e2e/HomePage.ts"],
			includeRawLocators: true,
		});
		expect(
			scoped.matched.some((one) => one.ui.id === "Orphan"),
			"a spec selects it by name, so it is not uncovered",
		).toBe(true);
	});

	it("still reports it uncovered when the sweep is off", () => {
		const scoped = report(files, { poInclude: ["e2e/HomePage.ts"] });
		expect(scoped.uncoveredTestIds.some((one) => one.id === "Orphan")).toBe(
			true,
		);
	});
});

describe("what scope.pageObjectFilesScanned counts", () => {
	/**
	 * The block a reader consults to judge how much of the repository a report
	 * covers. `usages` carries the raw-locator sweep too once
	 * `includeRawLocators` is on, so counting it made every spec file holding a
	 * `getByTestId` a "page-object file" - one page object and forty specs
	 * reporting forty-one.
	 */
	const SPECS = {
		"e2e/a.spec.ts": [
			'import { test } from "@playwright/test";',
			'test("a", async ({ page }) => {',
			'  await page.getByTestId("Orphan").click();',
			"});",
		].join("\n"),
		"e2e/b.spec.ts": [
			'import { test } from "@playwright/test";',
			'test("b", async ({ page }) => {',
			'  await page.getByTestId("PromoCodeInput").click();',
			"});",
		].join("\n"),
	};

	it("counts page-object files, not the specs the sweep visited", () => {
		const withRaw = report(SPECS, { includeRawLocators: true });
		const withoutRaw = report(SPECS);
		expect(withRaw.scope.pageObjectFilesScanned).toBe(
			withoutRaw.scope.pageObjectFilesScanned,
		);
		expect(withRaw.scope.pageObjectFilesScanned).toBe(1);
	});

	it("still counts the page-object file that contributed the selectors", () => {
		expect(report().scope.pageObjectFilesScanned).toBe(1);
	});
});
