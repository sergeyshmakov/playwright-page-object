import { describe, expect, it } from "vitest";
import { buildCoverageReport } from "../../../analysis/coverage/mapCoverage";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import type { UiNode } from "../../../analysis/types";
import { libImport, makeWorkspace } from "../helpers/inMemory";

/**
 * The other half of the fabrication problem: ids that really do render, dropped
 * on the floor.
 *
 * A wrong id sends a reader to a selector that times out. A *missing* one is
 * quieter and can be worse, because the report does not go blank — it fills the
 * gap with a confident wrong verdict. An id erased from the inventory comes back
 * as `deadSelectors`, which reads as "delete this selector", and a locator
 * branch never swept comes back as `uncoveredTestIds`, which reads as "nothing
 * tests this". Both are the report asserting something it never checked.
 */

const BOOTSTRAP = {
	"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
};

function flatten(nodes: UiNode[]): UiNode[] {
	return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/** A template hole in fixture *source*, assembled so it is not one here. */
const hole = (name: string): string => `\${${name}}`;

describe("ids the analysis must not erase", () => {
	const CHOICE_UI = {
		"src/App.tsx": [
			'import Row from "./Row";',
			"export default function App({ big }: { big: boolean }) {",
			'  return <Row rowId={big ? "RowWide" : "RowNarrow"} />;',
			"}",
		].join("\n"),
		"src/Row.tsx": [
			"export default function Row({ rowId }: { rowId: string }) {",
			"  return <div data-testid={rowId} />;",
			"}",
		].join("\n"),
	};

	it("keeps both branches of a static choice the call site forwards", () => {
		const tree = buildTestIdTree(makeWorkspace({ ...BOOTSTRAP, ...CHOICE_UI }));
		const div = flatten(tree.roots).find((node) => node.tag === "div");
		expect(div?.testId).toMatchObject({ value: "RowWide" });
		expect(div?.testIdAlternatives).toMatchObject([{ value: "RowNarrow" }]);
	});

	it("puts the forwarded alternative in the inventory too", () => {
		// The tree is where a reader looks; the inventory is what coverage matches
		// against. An id in one and not the other is the shape that produced a dead
		// verdict for a selector that works.
		const tree = buildTestIdTree(makeWorkspace({ ...BOOTSTRAP, ...CHOICE_UI }));
		const rendered = tree.inventory
			.filter((occurrence) => occurrence.reach === "forwarded")
			.map((occurrence) => occurrence.value.value);
		expect(rendered).toContain("RowWide");
		expect(rendered).toContain("RowNarrow");
	});

	it("does not call a selector for the second branch dead", () => {
		const report = buildCoverageReport(
			makeWorkspace({
				...BOOTSTRAP,
				...CHOICE_UI,
				"e2e/RowPage.ts": [
					'import type { Locator } from "@playwright/test";',
					libImport("RootPageObject", "RootSelector", "Selector"),
					"@RootSelector()",
					"export class RowPage extends RootPageObject {",
					'  @Selector("RowNarrow")',
					"  accessor Narrow!: Locator;",
					"}",
				].join("\n"),
			}),
		);
		expect(report.deadSelectors.map((entry) => entry.memberPath)).not.toContain(
			"RowPage.Narrow",
		);
		expect(report.matched.map((entry) => entry.ui.id)).toContain("RowNarrow");
	});

	it("sweeps both branches of a ternary inside getByTestId", () => {
		const report = buildCoverageReport(
			makeWorkspace({
				...BOOTSTRAP,
				"src/App.tsx": [
					"export default function App() {",
					"  return (",
					"    <main>",
					'      <i data-testid="IconOn" />',
					'      <i data-testid="IconOff" />',
					"    </main>",
					"  );",
					"}",
				].join("\n"),
				"e2e/toggle.spec.ts": [
					'import { test } from "@playwright/test";',
					"declare const on: boolean;",
					"test('t', async ({ page }) => {",
					'  await page.getByTestId(on ? "IconOn" : "IconOff").click();',
					"});",
				].join("\n"),
			}),
			{ includeRawLocators: true },
		);
		const uncovered = report.uncoveredTestIds.map((entry) => entry.id);
		expect(uncovered).not.toContain("IconOn");
		expect(uncovered).not.toContain("IconOff");
	});

	it("discloses unproven sites behind a pattern match, not only an id match", () => {
		// `alsoUnproven` was keyed on the matched id, and a pattern match has none —
		// so the disclosure was dead code for exactly the speculative matches least
		// able to speak for themselves. Here the selector matches a rendered
		// *pattern*, while a prop-side pattern it also fits is the site the page
		// object was really written for. A direct hit on either side would outrank
		// the speculative rung and never reach this code, so both sides are
		// patterns.
		const report = buildCoverageReport(
			makeWorkspace({
				...BOOTSTRAP,
				"src/App.tsx": [
					'import WithIcon from "./WithIcon";',
					"export default function App({ n, m }: { n: number; m: number }) {",
					"  return (",
					"    <main>",
					`      <span data-testid={\`Info${hole("n")}\`} />`,
					`      <WithIcon data-testid={\`Info${hole("m")}\`} />`,
					"    </main>",
					"  );",
					"}",
				].join("\n"),
				"src/WithIcon.tsx": [
					"export default function WithIcon({ label }: { label?: string }) {",
					"  return <b>{label}</b>;",
					"}",
				].join("\n"),
				"e2e/InfoPage.ts": [
					'import type { Locator } from "@playwright/test";',
					libImport("RootPageObject", "RootSelector", "Selector"),
					"@RootSelector()",
					"export class InfoPage extends RootPageObject {",
					'  @Selector("Info42")',
					"  accessor Info!: Locator;",
					"}",
				].join("\n"),
			}),
		);
		const entry = report.matched.find(
			(match) => match.selector.memberPath === "InfoPage.Info",
		);
		expect(entry).toBeDefined();
		expect(entry?.ui.id).toBeNull();
		expect(entry?.unprovenOccurrences).toBe(1);
		expect(entry?.unprovenAt).toBeDefined();
	});
});
