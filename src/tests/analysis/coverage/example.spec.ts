import { describe, expect, it } from "vitest";
import { buildCoverageReport } from "../../../analysis/coverage/mapCoverage";
import { exampleWorkspace } from "../helpers/example";

describe("example/ — end-to-end coverage", () => {
	const report = buildCoverageReport(exampleWorkspace());

	it("uses the Playwright default attribute", () => {
		expect(report.attribute).toBe("data-testid");
	});

	it("matches the CartItem_ list selector to the template-literal id by probe", () => {
		const listMatch = report.matched.find(
			(entry) => entry.selector.memberPath === "CheckoutPage.CartItems",
		);
		expect(listMatch).toBeDefined();
		expect(listMatch?.ui.patternSource).toBe("^CartItem_.+$");
		expect(listMatch?.confidence).toBe("probe");
		expect(listMatch?.probe).toBe("CartItem_1");
	});

	it("matches the root selectors of both checkout page objects", () => {
		const roots = report.matched
			.filter((entry) => entry.ui.id === "CheckoutPage")
			.map((entry) => entry.selector.memberPath)
			.sort();
		expect(roots).toEqual(["CheckoutPage", "ExternalCheckoutPage"]);
	});

	it("reaches the fragment nested behind a factory argument", () => {
		expect(report.matched.map((entry) => entry.selector.memberPath)).toContain(
			"PlainHostCheckoutPage.PromoSection.PromoInput",
		);
	});

	it("surfaces the ids nothing selects", () => {
		const uncovered = report.uncoveredTestIds.map((entry) => entry.id);
		for (const id of [
			"PromoApplied",
			"CartItemName",
			"CartItemPrice",
			"SignIn",
			"EmptyCart",
			"CartItemsList",
			"CartSection",
		]) {
			expect(uncovered).toContain(id);
		}
		expect(uncovered).not.toContain("PromoCodeInput");
		expect(uncovered).not.toContain("CheckoutPage");
		expect(uncovered).not.toContain("PromoSection");
	});

	it("reports no dead selectors", () => {
		expect(report.deadSelectors).toEqual([]);
		expect(report.summary.deadSelectors).toBe(0);
	});

	it("keeps the role selectors in their own bucket", () => {
		const roleSelectors = report.nonTestIdSelectors.filter(
			(entry) => entry.kind === "role",
		);
		expect(roleSelectors.length).toBeGreaterThan(0);
		expect(roleSelectors.map((entry) => entry.memberPath)).toContain(
			"CheckoutPage.CartItems[item].RemoveButton",
		);
	});

	it("has nothing dynamic on either side", () => {
		expect(report.summary.unknownSelectors).toBe(0);
		expect(report.summary.unknownTestIds).toBe(0);
	});

	// The widened sweep reads every file discovery reads, not just `*.spec.ts`.
	// The `includes("TestId")` pre-filter is what keeps that from becoming a
	// second full AST descent over the repository, so its cost is asserted.
	it("keeps the widened locator sweep close to the report it rides on", () => {
		const ws = exampleWorkspace();
		buildCoverageReport(ws); // Warm the parse and the discovery memo.

		const plainStarted = Date.now();
		buildCoverageReport(ws);
		const plain = Date.now() - plainStarted;

		const sweptStarted = Date.now();
		const swept = buildCoverageReport(ws, { includeRawLocators: true });
		const withSweep = Date.now() - sweptStarted;

		expect(swept.summary.rawSelectors).toBeGreaterThan(0);
		expect(withSweep).toBeLessThan(Math.max(250, plain * 6));
	});

	it("reads all four locator call names, not just getByTestId", () => {
		const swept = buildCoverageReport(exampleWorkspace(), {
			includeRawLocators: true,
		});
		const raw = swept.matched
			.filter((entry) => entry.selector.origin === "raw")
			.map((entry) => entry.selector.text);
		expect(raw.some((text) => text.includes("getItemByTestId"))).toBe(true);
		expect(raw.some((text) => text.includes("filterByItemTestId"))).toBe(true);
	});

	it("computes a coverage ratio strictly between 0 and 1", () => {
		expect(report.summary.coverage).toBeGreaterThan(0);
		expect(report.summary.coverage).toBeLessThan(1);
		expect(report.summary.coveredUiTestIds).toBe(
			report.summary.matchableUiTestIds - report.uncoveredTestIds.length,
		);
	});
});
