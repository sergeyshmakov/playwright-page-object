import {
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_RESPONSE_BYTES } from "../../mcp/respond";
import {
	callTool,
	closeAllClients,
	connect,
	hole,
	MAX_BUCKET_PAGE,
	pageObjectSource,
	withProject,
} from "./helpers/mcpClient";

afterAll(closeAllClients);

describe("coverage paging over the transport", () => {
	// The lookup used to answer "yes, at src/App.tsx:3" about an element whose
	// id is built entirely at run time, which matches anything and proves nothing.
	it("does not answer a testId lookup with a match-anything element", async () => {
		await withProject(
			"ppo-catch-all-lookup-",
			{
				"src/App.tsx": [
					"export function App() {",
					"\tconst id = String(Math.random());",
					`\treturn <div data-testid={\`${hole("id")}\`} />;`,
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { envelope } = await callTool(client, "get_testid_tree", {
					testId: "Whatever",
				});
				expect(envelope.data).toEqual({ occurrences: [] });
				const hint = String(envelope.meta?.hint);
				expect(hint).toContain("built entirely at runtime");
				expect(hint).toContain("excluded");
			},
		);
	}, 30_000);

	it("says so when every occurrence of an id is an unproven component prop", async () => {
		await withProject(
			"ppo-prop-lookup-",
			{
				"src/Card.tsx": [
					"export default function Card(props: { children?: unknown }) {",
					"\treturn <div>{props.children as never}</div>;",
					"}",
					"",
				].join("\n"),
				"src/App.tsx": [
					'import Card from "./Card";',
					"export function App() {",
					'\treturn <Card data-testid="Ghost" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { envelope } = await callTool(client, "get_testid_tree", {
					testId: "Ghost",
				});
				const occurrences = (envelope.data as { occurrences: unknown[] })
					.occurrences;
				expect(occurrences).toHaveLength(1);
				expect(String(envelope.meta?.hint)).toContain(
					"prop on a component tag",
				);
			},
		);
	}, 30_000);

	/**
	 * The Stateful Tools half of phase 2: `map_coverage` hands out an opaque
	 * handle and `query_coverage` spends it, with the cursor living in the
	 * *arguments* because MCP has no pagination for tool results.
	 */
	describe("query_coverage", () => {
		/** Two page objects whose selectors are all dead, plus one rendered id. */
		const repo = {
			"e2e/Alpha.ts": pageObjectSource("Alpha"),
			"e2e/Beta.ts": pageObjectSource("Beta"),
			"src/App.tsx": [
				"export function App() {",
				'\treturn <div data-testid="OnlyRendered" />;',
				"}",
				"",
			].join("\n"),
		};

		it("mints a handle on a summary-only call and pages a bucket to its end", async () => {
			await withProject("ppo-handle-", repo, async (client) => {
				const first = await callTool(client, "map_coverage", { buckets: [] });
				expect(first.isError).toBe(false);
				// The cheapest possible coverage call is also where the walk starts,
				// so it has to carry the handle too.
				expect(Object.keys(first.envelope.data as object).sort()).toEqual([
					"scope",
					"summary",
				]);
				const coverageId = first.envelope.meta?.coverageId as string;
				expect(coverageId).toMatch(/^cov_[0-9a-f]{16}$/);

				const total = (
					first.envelope.data as { summary: Record<string, number> }
				).summary.deadSelectors;
				expect(total).toBeGreaterThan(1);

				const seen: unknown[] = [];
				let offset: number | undefined = 0;
				let calls = 0;
				while (offset !== undefined) {
					const page = await callTool(client, "query_coverage", {
						coverageId,
						bucket: "deadSelectors",
						offset,
						limit: 1,
					});
					expect(page.isError, JSON.stringify(page.envelope.error)).toBe(false);
					const data = page.envelope.data as {
						summary: Record<string, number>;
						deadSelectors: unknown[];
					};
					// Every page carries the same summary-shaped totals, so a capped
					// page still says how much it is hiding.
					expect(data.summary.deadSelectors).toBe(total);
					expect(page.envelope.meta?.bucket).toBe("deadSelectors");
					seen.push(...data.deadSelectors);
					offset = page.envelope.meta?.nextOffset as number | undefined;
					calls += 1;
					expect(calls, "the walk must terminate").toBeLessThan(total + 2);
				}
				expect(seen).toHaveLength(total);
				expect(calls).toBe(total);
			});
		}, 60_000);

		it("refuses an id it never issued, recoverably", async () => {
			await withProject("ppo-handle-unknown-", repo, async (client) => {
				const { isError, envelope } = await callTool(client, "query_coverage", {
					coverageId: "cov_0000000000000000",
					bucket: "matched",
				});
				expect(isError).toBe(true);
				expect(envelope.error?.code).toBe("expired_handle");
				expect(envelope.error?.message).toContain("not known");
				// Recoverable means the hint names the call that fixes it.
				expect(envelope.error?.hint).toContain("map_coverage");
			});
		}, 60_000);

		/**
		 * The invalidation decision, end to end. A handle survives calls that
		 * change nothing and dies the moment a source file does — a stored report
		 * carries a file and a line per entry, so paging it across an edit would
		 * hand back positions that have moved with nothing saying so.
		 */
		it("survives an unrelated call and expires when a source file changes", async () => {
			await withProject("ppo-handle-stale-", repo, async (client, root) => {
				const created = await callTool(client, "map_coverage", { buckets: [] });
				const coverageId = created.envelope.meta?.coverageId as string;

				await callTool(client, "list_page_objects", {});
				const still = await callTool(client, "query_coverage", {
					coverageId,
					bucket: "deadSelectors",
				});
				expect(still.isError, "nothing changed, so the id still spends").toBe(
					false,
				);

				const target = path.join(root, "e2e", "Alpha.ts");
				writeFileSync(
					target,
					`${readFileSync(target, "utf8")}\n// edited between two pages\n`,
					"utf8",
				);
				// Explicit, because a same-millisecond rewrite can leave the mtime
				// looking untouched on a coarse filesystem clock.
				const future = new Date(Date.now() + 5_000);
				utimesSync(target, future, future);

				const after = await callTool(client, "query_coverage", {
					coverageId,
					bucket: "deadSelectors",
				});
				expect(after.isError).toBe(true);
				expect(after.envelope.error?.code).toBe("expired_handle");
				expect(after.envelope.error?.message).toContain("changed on disk");
			});
		}, 60_000);
	});

	/**
	 * Auto-degrade: an oversized coverage payload comes back smaller, never as
	 * nothing. Before this, every one of these calls was a `too_large` error
	 * whose only content was advice.
	 */
	describe("oversized coverage responses", () => {
		/** Wide enough that one bucket cannot fit inside the response cap. */
		function fatPageObject(count: number): string {
			const lines = [
				'import type { Locator } from "@playwright/test";',
				'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
				"",
				'@RootSelector("FatPageRootSelectorThatIsRenderedNowhereAtAll")',
				"export class FatPage extends RootPageObject {",
			];
			// Wide on purpose. A coverage entry repeats its id in the selector text,
			// the member path and the decorator source, so the name is most of the
			// entry — and a page is capped at 200 now, so an entry has to be around
			// a kilobyte for a full page to overflow the response cap and exercise
			// the trimming this block exists to test.
			const padding = "AndThenSomeMoreWordsToMakeThisEntryWide".repeat(30);
			for (let index = 0; index < count; index += 1) {
				const name = `DeliberatelyDescriptiveDeadSelectorName${padding}${String(index).padStart(4, "0")}`;
				lines.push(`\t@Selector("${name}")`, `\taccessor ${name}!: Locator;`);
			}
			lines.push("}", "");
			return lines.join("\n");
		}

		const fatRepo = {
			"e2e/Fat.ts": fatPageObject(300),
			"src/App.tsx": [
				"export function App() {",
				'\treturn <div data-testid="OnlyRendered" />;',
				"}",
				"",
			].join("\n"),
		};

		it("trims each bucket to fit instead of returning too_large", async () => {
			await withProject("ppo-degrade-", fatRepo, async (client) => {
				const { isError, envelope, text } = await callTool(
					client,
					"map_coverage",
					{ buckets: ["deadSelectors"], limit: MAX_BUCKET_PAGE },
				);

				expect(
					isError,
					`expected a trimmed answer, got ${envelope.error?.code}`,
				).toBe(false);
				expect(text.length).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);

				const data = envelope.data as {
					summary: Record<string, number>;
					scope: unknown;
					deadSelectors: unknown[];
				};
				// summary and scope always ship: they are what a trimmed list is read
				// against, and without them an empty bucket reads as "nothing found".
				expect(data.summary.deadSelectors).toBe(301);
				expect(data.scope).toBeDefined();
				expect(data.deadSelectors.length).toBeGreaterThan(0);
				expect(data.deadSelectors.length).toBeLessThan(200);

				expect(envelope.meta?.truncatedBuckets).toEqual(["deadSelectors"]);
				expect(envelope.meta?.nextOffset).toEqual({
					deadSelectors: data.deadSelectors.length,
				});
				expect(envelope.meta?.truncated).toBe(true);
				expect(String(envelope.meta?.hint)).toContain("query_coverage");

				// The handle from that same trimmed response walks the rest, and
				// query_coverage degrades on exactly the same terms.
				const coverageId = envelope.meta?.coverageId as string;
				const seen: unknown[] = [];
				let offset: number | undefined = 0;
				let calls = 0;
				let everTrimmed = false;
				while (offset !== undefined) {
					const page = await callTool(client, "query_coverage", {
						coverageId,
						bucket: "deadSelectors",
						offset,
						limit: MAX_BUCKET_PAGE,
					});
					expect(page.isError, JSON.stringify(page.envelope.error)).toBe(false);
					expect(page.text.length).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
					const body = page.envelope.data as { deadSelectors: unknown[] };
					seen.push(...body.deadSelectors);
					if (page.envelope.meta?.truncatedBuckets !== undefined) {
						expect(page.envelope.meta.truncatedBuckets).toEqual([
							"deadSelectors",
						]);
						everTrimmed = true;
					}
					// One bucket, so one number: it copies straight into the next
					// call's offset, which is what makes the walk hard to get wrong.
					const next = page.envelope.meta?.nextOffset;
					expect(next === undefined || typeof next === "number").toBe(true);
					offset = next as number | undefined;
					calls += 1;
					expect(calls, "the walk must terminate").toBeLessThan(10);
				}
				expect(everTrimmed, "a full page of wide entries cannot have fit").toBe(
					true,
				);
				expect(seen).toHaveLength(301);
			});
		}, 120_000);

		/**
		 * The default whole-project call asks for all six buckets at once. Every
		 * one of them has to come back with something, or the trimming has simply
		 * moved the failure into the payload.
		 */
		it("spreads the budget across every requested bucket", async () => {
			await withProject("ppo-degrade-all-", fatRepo, async (client) => {
				const { isError, envelope, text } = await callTool(
					client,
					"map_coverage",
					{ limit: MAX_BUCKET_PAGE },
				);

				expect(isError).toBe(false);
				expect(text.length).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
				const data = envelope.data as Record<string, unknown[]> & {
					summary: Record<string, number>;
				};
				expect(data.deadSelectors.length).toBeGreaterThan(0);
				expect(data.uncoveredTestIds.length).toBe(1);
				expect(envelope.meta?.truncatedBuckets).toEqual(["deadSelectors"]);
			});
		}, 120_000);
	});

	it("returns success with a hint for an empty project", async () => {
		const emptyDir = mkdtempSync(path.join(tmpdir(), "ppo-empty-"));
		try {
			const { client } = await connect(emptyDir);
			const { isError, envelope } = await callTool(
				client,
				"list_page_objects",
				{},
			);

			expect(isError).toBe(false);
			expect(envelope.ok).toBe(true);
			expect(envelope.data).toEqual([]);
			expect(envelope.meta?.hint).toBeDefined();
		} finally {
			rmSync(emptyDir, { recursive: true, force: true });
		}
	}, 30_000);
});
