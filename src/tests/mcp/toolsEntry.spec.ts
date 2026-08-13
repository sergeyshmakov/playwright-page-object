import { afterAll, describe, expect, it } from "vitest";
import { callTool, closeAllClients, withProject } from "./helpers/mcpClient";

afterAll(closeAllClients);

describe("entry resolution over the transport", () => {
	// A suffix match is a convenience for a bare basename, never a competitor to
	// the fully spelled path. This wrapper resolves `file` before the engine sees
	// it, so its first-match search handed a monorepo's `src/App.tsx` request to
	// whichever candidate sorted first — the package copy.
	it("prefers the exact get_testid_tree file over an earlier suffix match", async () => {
		await withProject(
			"ppo-entry-exact-",
			{
				"packages/ui/src/App.tsx": [
					"export function App() {",
					'\treturn <div data-testid="PackageRoot" />;',
					"}",
					"",
				].join("\n"),
				"src/App.tsx": [
					"export function App() {",
					'\treturn <div data-testid="AppRoot" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const exact = await callTool(client, "get_testid_tree", {
					file: "src/App.tsx",
				});
				expect(exact.isError).toBe(false);
				const serialized = JSON.stringify(exact.envelope.data);
				expect(serialized).toContain("AppRoot");
				expect(serialized).not.toContain("PackageRoot");

				// A trailing segment that fits both names neither of them.
				const bare = await callTool(client, "get_testid_tree", {
					file: "App.tsx",
				});
				expect(bare.isError).toBe(true);
				expect(bare.envelope.error?.code).toBe("ambiguous_component");
				expect(bare.envelope.error?.candidates).toEqual([
					"packages/ui/src/App.tsx",
					"src/App.tsx",
				]);
			},
		);
	}, 30_000);

	// Resolving `file` exactly is only half of it: the `component` filter then
	// asked the same question a second time with a suffix rule, so the resolved
	// path was widened straight back to every file ending in it. A repository
	// that declares the name in only one of them was answered with that one,
	// whatever path the caller spelled.
	it("keeps the exact file when component narrows the search", async () => {
		await withProject(
			"ppo-entry-exact-component-",
			{
				"packages/ui/src/App.tsx": [
					"export function App() {",
					'\treturn <div data-testid="PackageRoot" />;',
					"}",
					"",
				].join("\n"),
				"src/App.tsx": [
					"export function App() {",
					'\treturn <div data-testid="AppRoot" />;',
					"}",
					"export function Home() {",
					'\treturn <div data-testid="HomeRoot" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				// Both files declare `App`; the fully spelled path settles it rather
				// than making the pair ambiguous all over again.
				const exact = await callTool(client, "get_testid_tree", {
					file: "src/App.tsx",
					component: "App",
				});
				expect(exact.isError).toBe(false);
				const serialized = JSON.stringify(exact.envelope.data);
				expect(serialized).toContain("AppRoot");
				expect(serialized).not.toContain("PackageRoot");

				// And a name the named file does not declare is a miss, not a licence
				// to root at a deeper file whose path happens to end the same way.
				const missing = await callTool(client, "get_testid_tree", {
					file: "packages/ui/src/App.tsx",
					component: "Home",
				});
				expect(missing.isError).toBe(true);
				expect(missing.envelope.error?.code).toBe("file_not_found");
				expect(missing.envelope.error?.candidates).toEqual(["src/App.tsx"]);
			},
		);
	}, 30_000);

	// A one-character typo in `component` used to be a dead end: file_not_found
	// with no suggestions, no candidates, and a hint that only said to try
	// something else.
	it("suggests the nearest component names for a typo'd component", async () => {
		await withProject(
			"ppo-component-typo-",
			{
				"src/components/GuestItem/GuestItemInfo.tsx": [
					"export function GuestItemInfo() {",
					'\treturn <div data-testid="GuestItemBox" />;',
					"}",
					"",
					"export function GuestItemActions() {",
					'\treturn <div data-testid="GuestItemActions" />;',
					"}",
					"",
				].join("\n"),
				"src/App.tsx": [
					"export function App() {",
					'\treturn <main data-testid="AppRoot" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const typo = await callTool(client, "get_testid_tree", {
					component: "GuestItemInf",
				});
				expect(typo.isError).toBe(true);
				expect(typo.envelope.error?.code).toBe("file_not_found");
				expect(typo.envelope.error?.suggestions).toContain("GuestItemInfo");

				// The suggestion has to work.
				const good = await callTool(client, "get_testid_tree", {
					component: "GuestItemInfo",
				});
				expect(good.isError).toBe(false);
				expect(JSON.stringify(good.envelope.data)).toContain("GuestItemBox");
			},
		);
	}, 30_000);

	// `component` + `file` has two ways to miss, and they need different lists:
	// the wrong symbol in the right file, and the right symbol in the wrong file.
	it("names a file's own components, and the files that declare a name", async () => {
		await withProject(
			"ppo-component-scoped-miss-",
			{
				"src/ui/Panel.tsx": [
					"export function Panel() {",
					'\treturn <div data-testid="PanelBox" />;',
					"}",
					"",
					"export function PanelHeader() {",
					'\treturn <h1 data-testid="PanelHeader" />;',
					"}",
					"",
				].join("\n"),
				"src/legacy/Panel.tsx": [
					"export function Panel() {",
					'\treturn <div data-testid="LegacyPanel" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				// Wrong symbol, right file: what that file declares is the answer.
				const wrongName = await callTool(client, "get_testid_tree", {
					component: "PanelFooter",
					file: "src/ui/Panel.tsx",
				});
				expect(wrongName.isError).toBe(true);
				expect(wrongName.envelope.error?.code).toBe("file_not_found");
				expect(wrongName.envelope.error?.suggestions).toEqual([
					"Panel",
					"PanelHeader",
				]);

				// Right symbol, wrong file: the files that declare it are the answer,
				// exactly as the page-object side answers `path.ts#ClassName`.
				const wrongFile = await callTool(client, "get_testid_tree", {
					component: "PanelHeader",
					file: "src/legacy/Panel.tsx",
				});
				expect(wrongFile.envelope.error?.code).toBe("file_not_found");
				expect(wrongFile.envelope.error?.candidates).toEqual([
					"src/ui/Panel.tsx",
				]);
				expect(String(wrongFile.envelope.error?.hint)).toContain("candidates");
			},
		);
	}, 30_000);

	// Two more paths that root nothing, both of which used to answer with a flat
	// inventory of everything instead of saying so.
	it("refuses a get_testid_tree file the scan never saw, naming the scope", async () => {
		await withProject(
			"ppo-testid-file-scope-",
			{
				"src/App.tsx": [
					"export function App() {",
					'\treturn <main data-testid="AppRoot" />;',
					"}",
					"",
				].join("\n"),
				"src/util/format.ts": "export const format = (x: string) => x;\n",
				"legacy/Old.tsx": [
					"export function Old() {",
					'\treturn <div data-testid="OldBox" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				// On disk, but outside the scanned scope: the fix is the server's
				// scope, not another path, so the hint has to say that.
				const unscanned = await callTool(client, "get_testid_tree", {
					file: "legacy/Old.tsx",
				});
				expect(unscanned.isError).toBe(true);
				expect(unscanned.envelope.error?.code).toBe("file_not_found");
				expect(String(unscanned.envelope.error?.hint)).toContain("--src-dir");

				// Scanned, but a .ts file cannot root a tree.
				const notJsx = await callTool(client, "get_testid_tree", {
					file: "src/util/format.ts",
				});
				expect(notJsx.isError).toBe(true);
				expect(notJsx.envelope.error?.code).toBe("file_not_found");
				expect(String(notJsx.envelope.error?.message)).toContain(".tsx");
			},
			{ srcDirs: ["src"] },
		);
	}, 30_000);

	// This used to fail with `ambiguous_component`: the engine could only root a
	// file at its *first* component, so a sibling that nothing rendered was
	// unreachable and the handler had to refuse rather than answer with Alpha.
	// The engine roots at a named declaration now, so the honest answer exists.
	it("roots at a sibling component that nothing else renders", async () => {
		await withProject(
			"ppo-sibling-component-",
			{
				"src/Widgets.tsx": [
					"export function Alpha() {",
					'\treturn <div data-testid="AlphaBox" />;',
					"}",
					"",
					"export function Beta() {",
					'\treturn <div data-testid="BetaBox" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { isError, envelope } = await callTool(
					client,
					"get_testid_tree",
					{
						component: "Beta",
					},
				);

				expect(isError).toBe(false);
				expect(envelope.meta?.rootedAt).toBeUndefined();
				const serialized = JSON.stringify(envelope.data);
				expect(serialized).toContain("BetaBox");
				expect(serialized).not.toContain("AlphaBox");
			},
		);
	}, 30_000);

	it("map_coverage names the page objects that share the scoped class's file", async () => {
		await withProject(
			"ppo-shared-file-",
			{
				"e2e/pages.ts": [
					'import type { Locator } from "@playwright/test";',
					'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
					"",
					'@RootSelector("AlphaRoot")',
					"export class AlphaPage extends RootPageObject {",
					'\t@Selector("AlphaInput")',
					"\taccessor Input!: Locator;",
					"}",
					"",
					'@RootSelector("BetaRoot")',
					"export class BetaPage extends RootPageObject {",
					'\t@Selector("BetaInput")',
					"\taccessor Input!: Locator;",
					"}",
					"",
				].join("\n"),
				"src/App.tsx": [
					"export function App() {",
					'\treturn <div><input data-testid="AlphaInput" /></div>;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { isError, envelope } = await callTool(client, "map_coverage", {
					class: "AlphaPage",
				});

				expect(isError).toBe(false);
				expect(
					envelope.meta?.alsoIncluded,
					"scoping is by file, so the sibling class must be disclosed",
				).toEqual(["BetaPage"]);
			},
		);
	}, 30_000);

	/**
	 * Scoping narrows the selectors and cannot narrow the ids they are compared
	 * against, so `uncoveredTestIds` on a scoped call is every id in the
	 * application — 61,788 bytes of them on a real app, nearly all covered by
	 * page objects the caller did not ask about. The report explained this in a
	 * warning you had to buy the whole list to read.
	 */
	it("map_coverage leaves the project-wide list out of a scoped call", async () => {
		const files = {
			"e2e/AlphaPage.ts": [
				'import type { Locator } from "@playwright/test";',
				'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
				"",
				'@RootSelector("AlphaRoot")',
				"export class AlphaPage extends RootPageObject {",
				'\t@Selector("AlphaInput")',
				"\taccessor Input!: Locator;",
				"}",
				"",
			].join("\n"),
			"src/App.tsx": [
				"export function App() {",
				"\treturn (",
				"\t\t<div>",
				'\t\t\t<input data-testid="AlphaInput" />',
				'\t\t\t<span data-testid="SomebodyElsesId" />',
				'\t\t\t<span data-testid="AnotherStrangersId" />',
				"\t\t</div>",
				"\t);",
				"}",
				"",
			].join("\n"),
		};

		await withProject("ppo-scoped-unused-", files, async (client) => {
			const scoped = await callTool(client, "map_coverage", {
				class: "AlphaPage",
			});
			const data = scoped.envelope.data as {
				uncoveredTestIds?: unknown[];
				summary: { uncoveredTestIds: number };
			};

			expect(data.uncoveredTestIds).toBeUndefined();
			// Left out of the payload, never out of the accounting.
			expect(data.summary.uncoveredTestIds).toBe(2);
			expect(String(scoped.envelope.meta?.hint ?? "")).toContain(
				'buckets:["uncoveredTestIds"]',
			);

			// Asking still works, both ways.
			const asked = await callTool(client, "map_coverage", {
				class: "AlphaPage",
				includeUnused: true,
			});
			expect(
				(asked.envelope.data as { uncoveredTestIds: unknown[] })
					.uncoveredTestIds,
			).toHaveLength(2);

			const byBucket = await callTool(client, "map_coverage", {
				class: "AlphaPage",
				buckets: ["uncoveredTestIds"],
			});
			expect(
				(byBucket.envelope.data as { uncoveredTestIds: unknown[] })
					.uncoveredTestIds,
			).toHaveLength(2);
		});

		// An unscoped call is unchanged: there the list is the answer.
		await withProject("ppo-unscoped-unused-", files, async (client) => {
			const { envelope } = await callTool(client, "map_coverage", {});
			expect(
				(envelope.data as { uncoveredTestIds: unknown[] }).uncoveredTestIds,
			).toHaveLength(2);
		});
	}, 30_000);
});
