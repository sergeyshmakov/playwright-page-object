import { afterAll, describe, expect, it } from "vitest";
import {
	callTool,
	closeAllClients,
	connect,
	exampleRoot,
	hole,
	warningCodes,
	withProject,
} from "./helpers/mcpClient";

afterAll(closeAllClients);

describe("naming a component or file over the transport", () => {
	// The default report advises `includeRawLocators`; advice a caller cannot act
	// on is worse than none, so the option has to exist on the tool itself.
	it("map_coverage can act on its own includeRawLocators advice", async () => {
		await withProject(
			"ppo-raw-locators-",
			{
				"src/App.tsx": [
					"export function App() {",
					'\treturn <div><input data-testid="RawOnlyInput" /></div>;',
					"}",
					"",
				].join("\n"),
				"e2e/raw.spec.ts": [
					'import { test } from "@playwright/test";',
					"",
					'test("selects the input directly", async ({ page }) => {',
					'\tawait page.getByTestId("RawOnlyInput").click();',
					"});",
					"",
				].join("\n"),
			},
			async (client) => {
				type Report = {
					summary: { coveredUiTestIds: number; matchableUiTestIds: number };
					matched: unknown[];
					uncoveredTestIds: Array<{ id: string | null }>;
				};

				const off = await callTool(client, "map_coverage", {});
				expect(off.isError).toBe(false);
				const offData = off.envelope.data as Report;
				expect(offData.summary.matchableUiTestIds).toBe(1);
				expect(offData.summary.coveredUiTestIds).toBe(0);
				expect(offData.uncoveredTestIds.map((entry) => entry.id)).toEqual([
					"RawOnlyInput",
				]);
				expect(
					warningCodes(off.envelope),
					"the advisory has to ship, or nobody knows the sweep was skipped",
				).toContain("raw-locators-disabled");

				const on = await callTool(client, "map_coverage", {
					includeRawLocators: true,
				});
				expect(on.isError).toBe(false);
				const onData = on.envelope.data as Report;
				expect(onData.summary.coveredUiTestIds).toBe(1);
				expect(onData.uncoveredTestIds).toEqual([]);
				expect(JSON.stringify(onData.matched)).toContain("e2e/raw.spec.ts");
				expect(warningCodes(on.envelope)).not.toContain(
					"raw-locators-disabled",
				);
			},
		);
	}, 30_000);

	// An unmatched `file` used to select zero page objects and still return a
	// "successful" report in which every rendered id was uncovered.
	it("map_coverage accepts a ./-prefixed file and rejects an unmatched one", async () => {
		await withProject(
			"ppo-coverage-file-",
			{
				"e2e/Home.ts": [
					'import type { Locator } from "@playwright/test";',
					'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
					"",
					'@RootSelector("HomeRoot")',
					"export class HomePage extends RootPageObject {",
					'\t@Selector("HomeInput")',
					"\taccessor Input!: Locator;",
					"}",
					"",
				].join("\n"),
				"src/App.tsx": [
					"export function App() {",
					'\treturn <div data-testid="HomeRoot"><input data-testid="HomeInput" /></div>;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const dotted = await callTool(client, "map_coverage", {
					file: "./e2e/Home.ts",
				});
				expect(dotted.isError).toBe(false);
				const data = dotted.envelope.data as {
					summary: { coveredUiTestIds: number; testIdSelectors: number };
				};
				expect(data.summary.testIdSelectors).toBe(2);
				expect(
					data.summary.coveredUiTestIds,
					"a conventional ./ prefix must not read as an empty scope",
				).toBe(2);

				const typo = await callTool(client, "map_coverage", {
					file: "e2e/Hom.ts",
				});
				expect(typo.isError).toBe(true);
				expect(typo.envelope.error?.code).toBe("file_not_found");
				expect(typo.envelope.error?.suggestions).toContain("e2e/Home.ts");
				expect(typo.envelope.error?.hint).toContain("list_page_objects");
			},
		);
	}, 30_000);

	it("map_coverage flags truncation for every capped list it actually returns", async () => {
		const roles = [1, 2, 3, 4]
			.map((index) =>
				[
					`\t@SelectorByRole("button", { name: "Button${index}" })`,
					`\taccessor Button${index}!: Locator;`,
				].join("\n"),
			)
			.join("\n");
		await withProject(
			"ppo-truncation-",
			{
				"e2e/ids.ts": [
					'import type { Locator } from "@playwright/test";',
					'import { PageObject, Selector } from "playwright-page-object";',
					"",
					"export class Ids extends PageObject {",
					'\t@Selector("Used")',
					"\taccessor Used!: Locator;",
					"}",
					"",
				].join("\n"),
				"e2e/roles.ts": [
					'import type { Locator } from "@playwright/test";',
					'import { PageObject, SelectorByRole } from "playwright-page-object";',
					"",
					"export class Roles extends PageObject {",
					roles,
					"}",
					"",
				].join("\n"),
				"src/App.tsx": [
					"export function App() {",
					"\treturn (",
					"\t\t<div>",
					'\t\t\t<b data-testid="Used" />',
					'\t\t\t<b data-testid="UnusedA" />',
					'\t\t\t<b data-testid="UnusedB" />',
					"\t\t</div>",
					"\t);",
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				// Two uncovered ids overflow limit 1, but that list is not returned.
				const hidden = await callTool(client, "map_coverage", {
					file: "e2e/ids.ts",
					limit: 1,
					includeUnused: false,
				});
				expect(hidden.envelope.meta?.truncated).toBeUndefined();

				const shown = await callTool(client, "map_coverage", {
					file: "e2e/ids.ts",
					limit: 1,
					includeUnused: true,
				});
				expect(shown.envelope.meta?.truncated).toBe(true);

				// Four role selectors overflow limit 3; nothing else does.
				const roleHeavy = await callTool(client, "map_coverage", {
					file: "e2e/roles.ts",
					limit: 3,
					includeUnused: false,
				});
				expect(roleHeavy.envelope.meta?.truncated).toBe(true);
			},
		);
	}, 30_000);

	it("every tool reports which source the test-id attribute came from", async () => {
		const { client } = await connect(exampleRoot);
		const calls: Array<[string, Record<string, unknown>]> = [
			["list_page_objects", {}],
			["get_page_object_tree", { class: "CheckoutPage" }],
			["get_testid_tree", {}],
			["map_coverage", {}],
		];

		for (const [name, args] of calls) {
			const { isError, envelope } = await callTool(client, name, args);
			expect(isError, `${name} must succeed`).toBe(false);
			expect(
				envelope.meta?.attributeSource,
				`${name} must report meta.attributeSource`,
			).toBeDefined();
		}
	}, 60_000);

	it("list_page_objects keeps the flags of a regex root selector", async () => {
		await withProject(
			"ppo-pattern-flags-",
			{
				"e2e/rows.ts": [
					'import type { Locator } from "@playwright/test";',
					'import { ListRootSelector, RootPageObject, Selector } from "playwright-page-object";',
					"",
					"@ListRootSelector(/Row_/i)",
					"export class RowsPage extends RootPageObject {",
					'\t@Selector("RowName")',
					"\taccessor Name!: Locator;",
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { envelope } = await callTool(client, "list_page_objects", {});
				const items = envelope.data as Array<{
					name: string;
					root?: { pattern?: string; patternFlags?: string };
				}>;
				const rows = items.find((item) => item.name === "RowsPage");
				expect(rows?.root?.pattern).toBe("Row_");
				expect(
					rows?.root?.patternFlags,
					"dropping /i reads as a case-sensitive locator",
				).toBe("i");
			},
		);
	}, 30_000);

	/**
	 * The field failure, end to end.
	 *
	 * A monorepo whose Playwright config lives at
	 * `playwright/playwright.base.config.ts` and whose components use `data-tid`.
	 * The old fixed-basename probe looked at `<root>` and `<root>/{test,tests,e2e}`
	 * only, found nothing, assumed `data-testid`, and every tool answered
	 * confidently about a repository it had mis-read — with no warnings at all.
	 */
	it("reads a config from a directory no fixed list would have probed", async () => {
		await withProject(
			"ppo-nested-config-",
			{
				"playwright/playwright.base.config.ts": [
					'import { defineConfig } from "@playwright/test";',
					"export default defineConfig({",
					'\ttestDir: "../e2e",',
					'\tuse: { testIdAttribute: "data-tid" },',
					"});",
					"",
				].join("\n"),
				"src/App.tsx": [
					"export function App() {",
					'\treturn <div data-tid="AppRoot"><input data-tid="EmailInput" /></div>;',
					"}",
					"",
				].join("\n"),
				"e2e/LoginPage.ts": [
					'import type { Locator } from "@playwright/test";',
					'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
					"",
					'@RootSelector("AppRoot")',
					"export class LoginPage extends RootPageObject {",
					'\t@Selector("EmailInput")',
					"\taccessor Email!: Locator;",
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const calls: Array<[string, Record<string, unknown>]> = [
					["list_page_objects", {}],
					["get_page_object_tree", { class: "LoginPage" }],
					["get_testid_tree", {}],
					["map_coverage", {}],
				];

				for (const [name, args] of calls) {
					const { isError, envelope } = await callTool(client, name, args);
					expect(isError, `${name} must succeed`).toBe(false);
					expect(envelope.meta?.attribute, `${name} attribute`).toBe(
						"data-tid",
					);
					expect(envelope.meta?.attributeSource, `${name} source`).toBe(
						"playwright-config",
					);
					expect(envelope.meta?.playwrightConfig, `${name} config`).toBe(
						"playwright/playwright.base.config.ts",
					);
					expect(
						warningCodes(envelope),
						`${name} must not report a mismatch it does not have`,
					).not.toContain("attribute-mismatch");
				}

				// The point of getting the attribute right: the selectors match.
				const coverage = await callTool(client, "map_coverage", {});
				const report = coverage.envelope.data as {
					summary: { coveredUiTestIds: number; matchableUiTestIds: number };
					deadSelectors: unknown[];
				};
				expect(report.summary.matchableUiTestIds).toBe(2);
				expect(report.summary.coveredUiTestIds).toBe(2);
				expect(report.deadSelectors).toHaveLength(0);
			},
		);
	}, 30_000);

	// The other half of the same failure: when the attribute really is wrong,
	// nothing in the payload shape says so — the numbers all look healthy.
	it("shouts on every tool when the attribute does not match the sources", async () => {
		await withProject(
			"ppo-attr-mismatch-",
			{
				"src/App.tsx": [
					"export function App() {",
					"\treturn (",
					'\t\t<div data-tid="AppRoot">',
					'\t\t\t<input data-tid="EmailInput" />',
					'\t\t\t<button data-tid="SubmitButton" />',
					"\t\t</div>",
					"\t);",
					"}",
					"",
				].join("\n"),
				"e2e/LoginPage.ts": [
					'import type { Locator } from "@playwright/test";',
					'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
					"",
					'@RootSelector("AppRoot")',
					"export class LoginPage extends RootPageObject {",
					'\t@Selector("EmailInput")',
					"\taccessor Email!: Locator;",
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const calls: Array<[string, Record<string, unknown>]> = [
					["list_page_objects", {}],
					["get_page_object_tree", { class: "LoginPage" }],
					["get_testid_tree", {}],
					["get_testid_tree", { testId: "EmailInput" }],
					["map_coverage", {}],
				];

				for (const [name, args] of calls) {
					const { isError, envelope } = await callTool(client, name, args);
					expect(isError, `${name} must still answer`).toBe(false);
					expect(warningCodes(envelope), `${name} warnings`).toContain(
						"attribute-mismatch",
					);
					expect(
						String(envelope.meta?.hint ?? ""),
						`${name} must say which flag fixes it`,
					).toContain("--attribute data-tid");
				}
			},
		);
	}, 30_000);

	/**
	 * The one true negative that reads like a bug. `@ListSelector("Row")` matches
	 * `Row_1`, `Row_2`, … and coverage counts it matched, while looking up the
	 * bare prefix is correctly empty — nothing renders `Row` itself. Saying only
	 * "not found" invites the reader to delete a selector that works.
	 */
	it("explains a prefix that names an id family rather than an id", async () => {
		await withProject(
			"ppo-prefix-lookup-",
			{
				"src/List.tsx": [
					"export function List({ items }: { items: string[] }) {",
					"\treturn (",
					"\t\t<ul>",
					"\t\t\t{items.map((item) => (",
					`\t\t\t\t<li key={item} data-testid={\`Row_${hole("item")}\`} />`,
					"\t\t\t))}",
					"\t\t</ul>",
					"\t);",
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { envelope } = await callTool(client, "get_testid_tree", {
					testId: "Row",
				});

				expect(
					(envelope.data as { occurrences: unknown[] }).occurrences,
				).toEqual([]);
				const hint = String(envelope.meta?.hint ?? "");
				expect(hint).toContain("Row_*");
				expect(hint).toContain("is not dead");
				expect(hint).toContain('"Row_0"');
			},
		);
	}, 30_000);
});
