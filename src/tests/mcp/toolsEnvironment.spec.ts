import { afterAll, describe, expect, it } from "vitest";
import {
	callTool,
	closeAllClients,
	manyPageObjects,
	warningCodes,
	withProject,
} from "./helpers/mcpClient";

afterAll(closeAllClients);

describe("environment reporting over the transport", () => {
	/**
	 * The limit on that. A *complete* tree with no ids is a real finding — "this
	 * component renders none" — and suppressing it would turn an answer into a
	 * shrug.
	 */
	it("still ships a complete tree that legitimately renders no id", async () => {
		await withProject(
			"ppo-complete-no-id-",
			{
				"src/App.tsx": [
					"export function App() {",
					"\treturn <div><span /></div>;",
					"}",
					"",
				].join("\n"),
				"src/Other.tsx": [
					"export function Other() {",
					'\treturn <b data-testid="Elsewhere" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { envelope } = await callTool(client, "get_testid_tree", {
					component: "App",
					format: "json",
				});

				expect(envelope.meta?.fidelity).toBe("full");
				expect(envelope.meta?.suppressed).toBeUndefined();
				expect(
					(envelope.data as { roots: unknown[] }).roots.length,
				).toBeGreaterThan(0);
			},
		);
	}, 30_000);

	/**
	 * The nodes are real; every one of them is id-less, because the run read an
	 * attribute the sources do not use. 11 KB to say "you are reading the wrong
	 * attribute", which the warning and the hint already say in full.
	 */
	it("omits a tree the wrong attribute has emptied of every id", async () => {
		await withProject(
			"ppo-blind-tree-",
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
			},
			async (client) => {
				const { isError, envelope } = await callTool(
					client,
					"get_testid_tree",
					{ component: "App" },
				);

				expect(isError, "it must still answer").toBe(false);
				const data = envelope.data as { roots: unknown[] };
				expect(data.roots).toEqual([]);
				expect(String(envelope.meta?.suppressed ?? "")).toContain(
					"attribute-mismatch",
				);
				// The half that must survive: the reason, and the flag that fixes it.
				expect(String(envelope.meta?.hint ?? "")).toContain(
					"--attribute data-tid",
				);
			},
		);
	}, 30_000);

	/**
	 * A tree with even one id is shipped whole — the reader then has something to
	 * check the warning against, and suppressing it would hide a real answer.
	 */
	it("still ships a tree that found an id despite the warning", async () => {
		await withProject(
			"ppo-blind-partial-",
			{
				"src/App.tsx": [
					"export function App() {",
					"\treturn (",
					'\t\t<div data-tid="AppRoot">',
					'\t\t\t<input data-tid="EmailInput" />',
					'\t\t\t<span data-testid="TheOddOneOut" />',
					"\t\t</div>",
					"\t);",
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { envelope } = await callTool(client, "get_testid_tree", {
					component: "App",
					format: "json",
				});
				expect(envelope.meta?.suppressed).toBeUndefined();
				expect((envelope.data as { roots: unknown[] }).roots.length).toBe(1);
			},
		);
	}, 30_000);

	/**
	 * The same five calls, read the other way round: the codes survive (asserted
	 * above), and the 3,182 bytes of identical prose behind them do not. What
	 * makes that safe is the hint, which is rebuilt from the full warnings and
	 * ships whole every time — so the abbreviated call still carries the fix.
	 */
	it("sends a warning's text once per session, and its advice every time", async () => {
		await withProject(
			"ppo-warning-ledger-",
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
				const shape = async (): Promise<{
					warnings: Array<Record<string, unknown>>;
					hint: string;
					bytes: number;
				}> => {
					const { envelope, text } = await callTool(
						client,
						"list_page_objects",
						{},
					);
					return {
						warnings: (envelope.meta?.warnings ?? []) as Array<
							Record<string, unknown>
						>,
						hint: String(envelope.meta?.hint ?? ""),
						bytes: text.length,
					};
				};

				const first = await shape();
				const mismatch = first.warnings.find(
					(one) => one.code === "attribute-mismatch",
				);
				expect(mismatch?.message, "first call must explain itself").toEqual(
					expect.any(String),
				);

				const second = await shape();
				const repeat = second.warnings.find(
					(one) => one.code === "attribute-mismatch",
				);
				expect(repeat).toEqual({
					code: "attribute-mismatch",
					severity: "warning",
					repeat: 1,
				});
				expect(second.bytes).toBeLessThan(first.bytes);
				// The half that must never shrink.
				expect(second.hint).toBe(first.hint);
				expect(second.hint).toContain("--attribute data-tid");
			},
		);
	}, 30_000);

	it("tells a caller to fix the scope when no UI source was scanned", async () => {
		await withProject(
			"ppo-empty-scope-",
			{
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
				const { envelope } = await callTool(client, "map_coverage", {});
				expect(warningCodes(envelope)).toContain("scope-empty");
				expect(String(envelope.meta?.hint ?? "")).toContain("--src-dir");
			},
		);
	}, 30_000);

	it("honours --playwright-config over anything discovery would pick", async () => {
		await withProject(
			"ppo-explicit-config-",
			{
				"playwright.config.ts": [
					'export default { use: { testIdAttribute: "data-discovered" } };',
					"",
				].join("\n"),
				"config/pw.ts": [
					'export default { use: { testIdAttribute: "data-pinned" } };',
					"",
				].join("\n"),
				"src/App.tsx": [
					"export function App() {",
					'\treturn <div data-pinned="AppRoot" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { envelope } = await callTool(client, "get_testid_tree", {});
				expect(envelope.meta?.attribute).toBe("data-pinned");
				expect(envelope.meta?.playwrightConfig).toBe("config/pw.ts");
				expect(warningCodes(envelope)).not.toContain("attribute-mismatch");
			},
			{ playwrightConfig: "config/pw.ts" },
		);
	}, 30_000);

	/* ---------------------------------------------------------------------- */
	/* Paging, bucket selection and the advice attached to an empty answer.    */
	/* ---------------------------------------------------------------------- */

	/** One file declaring `count` trivially different page objects. */

	it("pages list_page_objects with offset and always reports the total", async () => {
		await withProject(
			"ppo-paging-",
			{ "e2e/many.ts": manyPageObjects(12) },
			async (client) => {
				const first = await callTool(client, "list_page_objects", {
					limit: 5,
				});
				expect((first.envelope.data as unknown[]).length).toBe(5);
				// Always, not only when it overflows: a caller who cannot tell a
				// complete list from a capped one has to re-call to find out.
				expect(first.envelope.meta?.total).toBe(12);
				expect(first.envelope.meta?.nextOffset).toBe(5);

				const second = await callTool(client, "list_page_objects", {
					limit: 5,
					offset: first.envelope.meta?.nextOffset as number,
				});
				expect((second.envelope.data as unknown[]).length).toBe(5);
				expect(second.envelope.meta?.offset).toBe(5);
				expect(second.envelope.meta?.nextOffset).toBe(10);

				const last = await callTool(client, "list_page_objects", {
					limit: 5,
					offset: 10,
				});
				expect((last.envelope.data as unknown[]).length).toBe(2);
				expect(
					last.envelope.meta?.nextOffset,
					"the final page must not invite another call",
				).toBeUndefined();

				const past = await callTool(client, "list_page_objects", {
					limit: 5,
					offset: 50,
				});
				expect(past.envelope.data).toEqual([]);
				expect(String(past.envelope.meta?.hint)).toContain("past the end");
			},
		);
	}, 30_000);

	// An index of 305 page objects and a filter that matches none of them used
	// to produce "no page objects were found; restart with --src-dir", sending a
	// caller to reconfigure a server that was working perfectly.
	it("blames the filter, not the scope, when the index is not empty", async () => {
		await withProject(
			"ppo-filter-miss-",
			{
				"e2e/many.ts": manyPageObjects(4),
				// Present so the environment hint stays quiet and the assertion is
				// about this tool's own advice rather than the workspace's.
				"src/App.tsx":
					'export function App() {\n\treturn <div data-testid="Screen0Input" />;\n}\n',
			},
			async (client) => {
				const { envelope } = await callTool(client, "list_page_objects", {
					filter: "checkout",
				});
				const hint = String(envelope.meta?.hint);
				expect(envelope.data).toEqual([]);
				expect(envelope.meta?.total).toBe(0);
				expect(hint).toContain('filter "checkout"');
				expect(hint).toContain("the index holds 4");
				expect(hint).not.toContain("--src-dir");
			},
		);
	}, 30_000);
});
