import { afterAll, describe, expect, it } from "vitest";
import {
	callTool,
	closeAllClients,
	connect,
	exampleRoot,
	withProject,
} from "./helpers/mcpClient";

afterAll(closeAllClients);

describe("coverage scoping over the transport", () => {
	/**
	 * The instructions used to promise `buckets: []` costs "a few hundred bytes".
	 * Measured on a production repository it was 5,362 B cold and 1,769 B warm —
	 * a number written into the prose and never checked. The claim is qualitative
	 * now, and this holds it to the only part that has to be true: summary-first
	 * is a small fraction of the full report, whatever repository it runs on.
	 */
	it("makes the summary-first call a small fraction of the full report", async () => {
		const { client } = await connect(exampleRoot);
		const summary = await callTool(client, "map_coverage", { buckets: [] });
		const full = await callTool(client, "map_coverage", {});

		expect(summary.envelope.ok).toBe(true);
		expect(summary.text.length).toBeLessThan(full.text.length / 3);
		// And it must still carry the two things it exists to deliver.
		const data = summary.envelope.data as Record<string, unknown>;
		expect(data.summary).toBeDefined();
		expect(data.scope).toBeDefined();
	}, 30_000);

	/**
	 * The same defect at a second call site: `map_coverage` scoping by a path
	 * that holds no page object. The previous round fixed the component branch
	 * and left this one, so the wording now comes from one shared helper.
	 */
	it("does not promise suggested paths when scoping by a UI file", async () => {
		await withProject(
			"ppo-scope-ui-file-",
			{
				"src/App.tsx": [
					"export function App() {",
					'\treturn <div data-testid="AppRoot" />;',
					"}",
					"",
				].join("\n"),
				"e2e/HomePage.ts": [
					'import type { Locator } from "@playwright/test";',
					'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
					"",
					'@RootSelector("AppRoot")',
					"export class HomePage extends RootPageObject {",
					'\t@Selector("Thing")',
					"\taccessor Thing!: Locator;",
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { isError, envelope } = await callTool(client, "map_coverage", {
					file: "src/App.tsx",
				});

				expect(isError).toBe(true);
				expect(envelope.error?.code).toBe("file_not_found");
				const hint = envelope.error?.hint ?? "";
				if ((envelope.error?.suggestions ?? []).length === 0) {
					expect(hint).not.toContain("suggested paths");
				} else {
					expect(hint).toContain("suggested paths");
				}
			},
		);
	}, 30_000);

	it("does not promise suggestions it has none of", async () => {
		await withProject(
			"ppo-no-suggestions-",
			{
				"src/App.tsx": [
					"export function App() {",
					'\treturn <div data-testid="AppRoot" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { envelope, isError } = await callTool(
					client,
					"get_testid_tree",
					{
						component: "Zzzzqqqxyzzy",
					},
				);

				expect(isError).toBe(true);
				expect(envelope.error?.suggestions ?? []).toEqual([]);
				// The hint used to say "pass one of the suggested names" beside an
				// empty list, sending the reader to look for something not sent.
				expect(envelope.error?.hint).not.toContain("suggested names");
				expect(envelope.error?.hint).toContain("Nothing in the scan resembles");
			},
		);
	}, 30_000);

	/**
	 * A walk of N pages repeated `scope` N times — byte-identical each time,
	 * because the handle pins one snapshot. `summary` repeats on purpose (a
	 * capped list is read against it); `scope` is prose the caller already has.
	 */
	it("ships scope on the first coverage page and not on the rest", async () => {
		await withProject(
			"ppo-page-scope-",
			{
				"e2e/Page.ts": [
					'import type { Locator } from "@playwright/test";',
					'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
					"",
					'@RootSelector("Root")',
					"export class HomePage extends RootPageObject {",
					...["A", "B", "C", "D"].flatMap((name) => [
						`\t@Selector("Missing${name}")`,
						`\taccessor ${name}!: Locator;`,
					]),
					"}",
					"",
				].join("\n"),
				"src/App.tsx": [
					"export function App() {",
					'\treturn <div data-testid="Root" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const created = await callTool(client, "map_coverage", { buckets: [] });
				const coverageId = String(created.envelope.meta?.coverageId);

				const first = await callTool(client, "query_coverage", {
					coverageId,
					bucket: "deadSelectors",
					limit: 2,
				});
				const second = await callTool(client, "query_coverage", {
					coverageId,
					bucket: "deadSelectors",
					offset: 2,
					limit: 2,
				});

				const firstData = first.envelope.data as Record<string, unknown>;
				const secondData = second.envelope.data as Record<string, unknown>;
				expect(firstData.scope).toBeDefined();
				expect(secondData.scope).toBeUndefined();
				// The number every capped page is read against stays on both.
				expect(firstData.summary).toBeDefined();
				expect(secondData.summary).toBeDefined();
			},
		);
	}, 30_000);

	/**
	 * "293 of 375 nodes were left unexpanded" is a count, not a list, so an agent
	 * could not tell "this id does not exist" from "the walk did not reach it" —
	 * and the whole promise of the tool is that absence means something. Measured
	 * on the real repo: a tree rooted at `GuestsList.tsx` reported ids from lines
	 * 29–50 of a component file and omitted two from lines 18 and 23 of the same
	 * file, which `map_coverage` located exactly.
	 */
	it("names the ids a holed tree read but did not place", async () => {
		await withProject(
			"ppo-unplaced-ids-",
			{
				"src/App.tsx": [
					'import { Wall } from "@vendor/ui";',
					'import { Panel } from "./Panel";',
					"export function App() {",
					"\treturn (",
					"\t\t<div>",
					'\t\t\t<span data-testid="Placed" />',
					"\t\t\t<Panel />",
					"\t\t\t<Wall />",
					"\t\t</div>",
					"\t);",
					"}",
					"",
				].join("\n"),
				// Two ids in this file: one the walk places, one behind a call it
				// cannot enter, so the file is walked but the id never lands.
				"src/Panel.tsx": [
					"function hidden() {",
					'\treturn <b data-testid="NeverPlaced" />;',
					"}",
					"export function Panel({ render }: { render?: () => JSX.Element }) {",
					'\treturn <section data-testid="PanelRoot">{render?.()}</section>;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { envelope } = await callTool(client, "get_testid_tree", {
					component: "App",
				});

				const unplaced = envelope.meta?.idsNotPlaced as
					| { ids: string[]; total: number }
					| undefined;
				expect(unplaced?.ids ?? []).toContain("NeverPlaced");
				// And what the tree did place is not listed as missing.
				expect(unplaced?.ids ?? []).not.toContain("Placed");
			},
		);
	}, 30_000);

	it("says nothing about unplaced ids when the tree is complete", async () => {
		await withProject(
			"ppo-no-unplaced-",
			{
				"src/App.tsx": [
					"export function App() {",
					'\treturn <div data-testid="Root"><span data-testid="Leaf" /></div>;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { envelope } = await callTool(client, "get_testid_tree", {
					component: "App",
				});
				expect(envelope.meta?.fidelity).toBe("full");
				expect(envelope.meta?.idsNotPlaced).toBeUndefined();
			},
		);
	}, 30_000);

	/**
	 * The hint used to be picked by fixed priority, so one depth-limited node
	 * decided the advice for a tree whose real problem was something else.
	 * Measured on a production page: 49 depth cuts against 178 external-module
	 * boundaries, and the reader was told to raise the depth — which cost 37%
	 * more bytes and returned nothing, because no depth reaches into a module
	 * that was never scanned.
	 */
	it("advises on the gap that dominates, not the first one it finds", async () => {
		await withProject(
			"ppo-gap-weight-",
			{
				"src/App.tsx": [
					'import { A, B, C, D } from "@vendor/ui";',
					'import { Deep1 } from "./Deep1";',
					"export function App() {",
					"\treturn (",
					"\t\t<div>",
					'\t\t\t<span data-testid="Anchor" />',
					"\t\t\t<A /><B /><C /><D />",
					"\t\t\t<Deep1 />",
					"\t\t</div>",
					"\t);",
					"}",
					"",
				].join("\n"),
				// One local chain, so a depth cut exists but is outnumbered.
				"src/Deep1.tsx": [
					'import { Deep2 } from "./Deep2";',
					"export function Deep1() {",
					"\treturn <Deep2 />;",
					"}",
					"",
				].join("\n"),
				"src/Deep2.tsx": [
					"export function Deep2() {",
					'\treturn <i data-testid="Bottom" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { envelope } = await callTool(client, "get_testid_tree", {
					component: "App",
					depth: 2,
				});

				const hint = String(envelope.meta?.hint ?? "");
				// Four external boundaries outweigh the single depth cut.
				expect(hint).toContain("outside the scanned sources");
				expect(hint).not.toContain("larger depth");
			},
		);
	}, 30_000);

	/**
	 * Rooting at a page whose content sits behind a router walks hundreds of
	 * scaffolding nodes and reaches no id at all — 43 KB on the measured page,
	 * none of it an answer. The walk being incomplete is what makes the nodes
	 * worthless: they prove nothing about what renders there.
	 */
	it("omits a cut tree that reached no id, and says where to look instead", async () => {
		await withProject(
			"ppo-zero-id-tree-",
			{
				"src/App.tsx": [
					'import { Wall } from "@vendor/ui";',
					'import { Hidden } from "./Hidden";',
					"export function App() {",
					"\treturn (",
					"\t\t<div>",
					"\t\t\t<Wall />",
					"\t\t\t<Wall />",
					"\t\t\t<Wall />",
					"\t\t\t<Hidden />",
					"\t\t</div>",
					"\t);",
					"}",
					"",
				].join("\n"),
				"src/Hidden.tsx": [
					"export function Hidden() {",
					'\treturn <span data-testid="OnlyRealId" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				// Rooted at App with the child walk off: every boundary is a hole and
				// nothing under it carries an id.
				const { isError, envelope } = await callTool(
					client,
					"get_testid_tree",
					{
						component: "App",
						followComponents: false,
					},
				);

				expect(isError).toBe(false);
				expect((envelope.data as { roots: unknown[] }).roots).toEqual([]);
				const suppressed = String(envelope.meta?.suppressed ?? "");
				expect(suppressed).toContain("reached no test id at all");
				// The two calls that do work, named.
				expect(suppressed).toContain("testId");
			},
		);
	}, 30_000);
});
