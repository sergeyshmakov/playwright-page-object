import { describe, expect, it } from "vitest";
import { buildCoverageReport } from "../../../analysis/coverage/mapCoverage";
import { PAGE_OBJECT, report } from "../helpers/coverageFixture";
import { libImport, makeWorkspace } from "../helpers/inMemory";

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
 * A scoped run divides two different questions.
 *
 * `poInclude` narrows the page-object side and nothing narrows the UI side, so
 * one class of a hundred scored a fraction of a percent against the whole
 * application — a number that reads as a broken suite. There is no honest
 * denominator to narrow to (nothing statically ties a page object to a subset
 * of the UI), so the ratio is refused and the two numbers it would have divided
 * are named in a warning.
 */
describe("buildCoverageReport — a scoped page-object side", () => {
	const scoped = report({}, { poInclude: ["e2e/HomePage.ts"] });

	it("refuses a ratio between a scoped numerator and a whole denominator", () => {
		expect(scoped.summary.coverage).toBeNull();
		// The numbers themselves still ship: a caller who wants the fraction can
		// see exactly which two it would be.
		expect(scoped.summary.coveredUiTestIds).toBe(1);
		expect(scoped.summary.matchableUiTestIds).toBe(3);
	});

	it("says which halves were scoped and which stayed project-wide", () => {
		const warning = scoped.warnings.find(
			(diagnostic) => diagnostic.code === "coverage-scope-narrowed",
		);
		expect(warning?.severity).toBe("warning");
		expect(warning?.message).toContain("e2e/HomePage.ts");
		expect(warning?.message).toContain("uncoveredTestIds");
		expect(warning?.data).toMatchObject({ covered: 1, matchable: 3 });
	});

	it("keeps the summary internally consistent either way", () => {
		expect(
			scoped.summary.coveredUiTestIds + scoped.summary.uncoveredTestIds,
		).toBe(scoped.summary.matchableUiTestIds);
	});

	it("leaves an unscoped run scoring, and silent about scope", () => {
		const whole = report();
		expect(whole.summary.coverage).toBeCloseTo(1 / 3);
		expect(whole.warnings.map((diagnostic) => diagnostic.code)).not.toContain(
			"coverage-scope-narrowed",
		);
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
