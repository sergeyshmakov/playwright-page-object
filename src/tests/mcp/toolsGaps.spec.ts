import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { coverageShrinkHint } from "../../mcp/present/coverage";
import {
	callTool,
	closeAllClients,
	manyPageObjects,
	withProject,
} from "./helpers/mcpClient";

afterAll(closeAllClients);

describe("tree gaps over the transport", () => {
	// `limit` caps at 500, so this response can only pass MAX_RESPONSE_BYTES on
	// entry width - hence the fat fixture. It was 400 thin ones while the cap
	// was 40 KB.
	it("names only its own knobs when a response is too large", async () => {
		await withProject(
			"ppo-too-large-",
			{ "e2e/many.ts": manyPageObjects(500, true) },
			async (client) => {
				const { isError, envelope } = await callTool(
					client,
					"list_page_objects",
					{ limit: 500 },
				);
				expect(isError).toBe(true);
				expect(envelope.error?.code).toBe("too_large");
				const hint = String(envelope.error?.hint);
				expect(hint).toContain("offset");
				expect(hint).toContain("limit");
				expect(hint, "list_page_objects has no depth").not.toContain("depth");
			},
		);
	}, 60_000);

	// The field trap: a caller who had already narrowed to one bucket was told
	// to pass `includeUnused:false`, which `selectedBuckets` ignores whenever
	// `buckets` is set. The re-call returned a byte-identical error, so the
	// advice cost a call and taught nothing.
	it("never advises a knob the current coverage arguments ignore", () => {
		const narrowed = coverageShrinkHint(["unknownTestIds"], 200);
		expect(narrowed).not.toContain("includeUnused:");
		expect(narrowed).toContain("limit");
		expect(narrowed).toContain("offset");

		const several = coverageShrinkHint(["unknownTestIds", "deadSelectors"], 50);
		expect(several).toContain("buckets");
		expect(several, "still ignored while buckets is set").not.toContain(
			"includeUnused:",
		);

		// Without `buckets` the flag is live, so recommending it is correct.
		const wide = coverageShrinkHint(undefined, 200);
		expect(wide).toContain("includeUnused:false");
		expect(wide).toContain("buckets");
	});

	it("returns only the requested coverage buckets, with totals intact", async () => {
		await withProject(
			"ppo-buckets-",
			{
				"e2e/Home.ts": [
					'import type { Locator } from "@playwright/test";',
					'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
					"",
					'@RootSelector("HomeRoot")',
					"export class HomePage extends RootPageObject {",
					'\t@Selector("HomeInput")',
					"\taccessor Input!: Locator;",
					'\t@Selector("Missing")',
					"\taccessor Gone!: Locator;",
					"}",
					"",
				].join("\n"),
				"src/App.tsx": [
					"export function App() {",
					'\treturn <div data-testid="HomeRoot"><input data-testid="HomeInput" /><b data-testid="Spare" /></div>;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { envelope } = await callTool(client, "map_coverage", {
					buckets: ["deadSelectors"],
				});
				const data = envelope.data as Record<string, unknown>;
				expect(Object.keys(data).sort()).toEqual([
					"deadSelectors",
					"scope",
					"summary",
				]);
				// The lists are gone; the numbers describing them are not.
				const summary = data.summary as Record<string, number>;
				expect(summary.uncoveredTestIds).toBe(1);
				expect(summary.matchableUiTestIds).toBe(3);
				// Nothing was overruled: this call never mentioned `includeUnused`, so
				// saying it was ignored would report a dropped argument that was never
				// passed.
				expect(envelope.meta?.ignored).toBeUndefined();

				// It is reported when there really was a conflict to resolve.
				const both = await callTool(client, "map_coverage", {
					buckets: ["deadSelectors"],
					includeUnused: true,
				});
				expect(both.envelope.meta?.ignored).toEqual(["includeUnused"]);

				// An empty list is a list: the cheapest coverage call there is, and
				// the one that used to return all six buckets instead of none.
				const none = await callTool(client, "map_coverage", { buckets: [] });
				const bare = none.envelope.data as Record<string, unknown>;
				expect(Object.keys(bare).sort()).toEqual(["scope", "summary"]);
				expect(none.envelope.meta?.ignored).toBeUndefined();
			},
		);
	}, 30_000);

	it("reports which buckets it capped", async () => {
		await withProject(
			"ppo-bucket-cap-",
			{
				"e2e/Home.ts": [
					'import type { Locator } from "@playwright/test";',
					'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
					"",
					'@RootSelector("HomeRoot")',
					"export class HomePage extends RootPageObject {",
					'\t@Selector("A")',
					"\taccessor A!: Locator;",
					'\t@Selector("B")',
					"\taccessor B!: Locator;",
					"}",
					"",
				].join("\n"),
				"src/App.tsx": [
					"export function App() {",
					'\treturn <div data-testid="HomeRoot"><i data-testid="A" /><i data-testid="B" /></div>;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { envelope } = await callTool(client, "map_coverage", {
					buckets: ["matched"],
					limit: 1,
				});
				expect(envelope.meta?.truncated).toBe(true);
				expect(envelope.meta?.shown).toEqual({ matched: 1 });
			},
		);
	}, 30_000);

	// 981 unknownTestIds in the field, a `limit` of 200, and no way to reach the
	// other 781: the bucket had no offset at all.
	it("pages one coverage bucket to its end with offset", async () => {
		const ids = [0, 1, 2, 3, 4, 5]
			.map((index) => `\t\t\t<i data-testid="Id${index}" />`)
			.join("\n");
		await withProject(
			"ppo-bucket-paging-",
			{
				"e2e/Home.ts": [
					'import type { Locator } from "@playwright/test";',
					'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
					"",
					'@RootSelector("Id0")',
					"export class HomePage extends RootPageObject {",
					'\t@Selector("Id0")',
					"\taccessor First!: Locator;",
					"}",
					"",
				].join("\n"),
				"src/App.tsx": [
					"export function App() {",
					"\treturn (",
					"\t\t<div>",
					ids,
					"\t\t</div>",
					"\t);",
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const page = async (offset: number) => {
					const { envelope } = await callTool(client, "map_coverage", {
						buckets: ["uncoveredTestIds"],
						limit: 2,
						offset,
					});
					return envelope;
				};

				const first = await page(0);
				const data = first.data as {
					summary: { uncoveredTestIds: number };
					uncoveredTestIds: Array<{ id: string }>;
				};
				// The total ships whatever this page holds, so an agent knows how far
				// it has to walk before it starts.
				expect(data.summary.uncoveredTestIds).toBe(5);
				expect(data.uncoveredTestIds).toHaveLength(2);
				expect(first.meta?.shown).toEqual({ uncoveredTestIds: 2 });
				expect(first.meta?.nextOffset).toEqual({ uncoveredTestIds: 2 });
				expect(first.meta?.truncated).toBe(true);
				expect(first.meta?.offset).toBeUndefined();

				const second = await page(2);
				expect(second.meta?.offset).toBe(2);
				expect(second.meta?.nextOffset).toEqual({ uncoveredTestIds: 4 });

				const last = await page(4);
				const lastData = last.data as {
					uncoveredTestIds: Array<{ id: string }>;
				};
				expect(lastData.uncoveredTestIds).toHaveLength(1);
				// The final page must not invite another call.
				expect(last.meta?.nextOffset).toBeUndefined();
				expect(last.meta?.truncated).toBeUndefined();

				// The point of the whole exercise: nothing is unreachable now.
				const walked = [first, second, last].flatMap((envelope) =>
					(
						envelope.data as { uncoveredTestIds: Array<{ id: string }> }
					).uncoveredTestIds.map((entry) => entry.id),
				);
				expect(walked.sort()).toEqual(["Id1", "Id2", "Id3", "Id4", "Id5"]);

				const past = await page(99);
				expect(
					(past.data as { uncoveredTestIds: unknown[] }).uncoveredTestIds,
				).toEqual([]);
				expect(String(past.meta?.hint)).toContain("past the end");
			},
		);
	}, 30_000);

	// Agents paste the path their editor shows them.
	it("accepts an absolute path inside the root and refuses one outside it", async () => {
		await withProject(
			"ppo-abs-path-",
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
			},
			async (client, root) => {
				const inside = await callTool(client, "get_page_object_tree", {
					file: path.join(root, "e2e", "Home.ts"),
				});
				expect(inside.isError).toBe(false);
				expect(String(inside.envelope.meta?.note)).toContain("e2e/Home.ts");

				const outside = await callTool(client, "get_page_object_tree", {
					file: path.join(tmpdir(), "elsewhere", "Home.ts"),
				});
				expect(outside.isError).toBe(true);
				expect(outside.envelope.error?.code).toBe("invalid_input");
				expect(String(outside.envelope.error?.message)).toContain(
					"outside the analysed project root",
				);
			},
		);
	}, 30_000);

	// A typo shares no substring with the real name, which is exactly when the
	// suggestion matters. Substring matching alone returned nothing.
	it("suggests a typo'd class name in map_coverage", async () => {
		await withProject(
			"ppo-coverage-typo-",
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
			},
			async (client) => {
				const { isError, envelope } = await callTool(client, "map_coverage", {
					class: "HmoePage",
				});
				expect(isError).toBe(true);
				expect(envelope.error?.code).toBe("class_not_found");
				expect(envelope.error?.suggestions).toContain("HomePage");
			},
		);
	}, 30_000);

	// `total(): number` on the methods line produced `await page.total()`.
	it("puts a getter on its own accessors line in the outline", async () => {
		await withProject(
			"ppo-outline-accessors-",
			{
				"e2e/Home.ts": [
					'import type { Locator } from "@playwright/test";',
					'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
					"",
					'@RootSelector("HomeRoot")',
					"export class HomePage extends RootPageObject {",
					'\t@Selector("HomeInput")',
					"\taccessor Input!: Locator;",
					"",
					"\tget total(): number {",
					"\t\treturn 1;",
					"\t}",
					"",
					"\tasync open(): Promise<void> {}",
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { envelope } = await callTool(client, "get_page_object_tree", {
					class: "HomePage",
					format: "outline",
				});
				const text = String(envelope.data);
				expect(text).toContain("methods: open(): Promise<void>");
				expect(text).toContain("accessors: get total: number");
			},
		);
	}, 30_000);
});
