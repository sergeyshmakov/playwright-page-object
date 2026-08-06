import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, describe, expect, it } from "vitest";
import type { McpServerOptions } from "../../mcp/options";
import { createMcpServer } from "../../mcp/server";

/**
 * In-process integration tests: a real Client talks to the real server over
 * a linked in-memory transport pair, with the analysis engine running against
 * the repo's own example/ app.
 */

const exampleRoot = path.resolve(process.cwd(), "example");

type ClientHandle = { client: Client; close: () => Promise<void> };
const openClients: ClientHandle[] = [];

async function connect(
	projectRoot: string,
	extra: Partial<McpServerOptions> = {},
): Promise<ClientHandle> {
	const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
	const server = createMcpServer({ projectRoot, ...extra });
	const client = new Client({ name: "vitest", version: "0.0.0" });
	await server.connect(serverEnd);
	await client.connect(clientEnd);
	const handle = {
		client,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
	openClients.push(handle);
	return handle;
}

afterAll(async () => {
	for (const handle of openClients) {
		await handle.close().catch(() => {});
	}
});

/** Minimal page object the discovery pass recognises, written to a temp repo. */
function pageObjectSource(className: string): string {
	return [
		'import type { Locator } from "@playwright/test";',
		'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
		"",
		`@RootSelector("${className}Root")`,
		`export class ${className} extends RootPageObject {`,
		`\t@Selector("${className}Input")`,
		"\taccessor Input!: Locator;",
		"}",
		"",
	].join("\n");
}

function writeFile(root: string, rel: string, body: string): void {
	const full = path.join(root, rel);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, body, "utf8");
}

/** Spins up a throwaway repo with `files`, connects, runs `body`, cleans up. */
async function withProject<T>(
	prefix: string,
	files: Record<string, string>,
	body: (client: Client) => Promise<T>,
	options: Partial<McpServerOptions> = {},
): Promise<T> {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	try {
		for (const [rel, contents] of Object.entries(files)) {
			writeFile(root, rel, contents);
		}
		const { client } = await connect(root, options);
		return await body(client);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

interface Envelope {
	ok: boolean;
	data?: unknown;
	meta?: Record<string, unknown>;
	error?: {
		code: string;
		message: string;
		candidates?: string[];
		suggestions?: string[];
		hint?: string;
	};
}

/** Diagnostic codes in `meta.warnings`; the key is absent when there are none. */
function warningCodes(envelope: Envelope): string[] {
	const warnings = envelope.meta?.warnings as
		| Array<{ code: string }>
		| undefined;
	return (warnings ?? []).map((warning) => warning.code);
}

async function callTool(
	client: Client,
	name: string,
	args: Record<string, unknown>,
): Promise<{ isError: boolean; envelope: Envelope }> {
	const result = (await client.callTool({ name, arguments: args })) as {
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
	};
	const text = result.content.find((block) => block.type === "text")?.text;
	expect(text, "tool must return a text block").toBeDefined();
	return {
		isError: result.isError === true,
		envelope: JSON.parse(text as string) as Envelope,
	};
}

describe("MCP server over in-memory transport", () => {
	it("lists exactly four read-only tools with substantial descriptions", async () => {
		const { client } = await connect(exampleRoot);
		const { tools } = await client.listTools();

		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"get_page_object_tree",
			"get_testid_tree",
			"list_page_objects",
			"map_coverage",
		]);

		for (const tool of tools) {
			expect(
				tool.description?.length ?? 0,
				`${tool.name} description is the product - it must not be truncated`,
			).toBeGreaterThan(200);
			expect(tool.annotations?.readOnlyHint).toBe(true);
		}
	}, 30_000);

	it("list_page_objects returns the example classes", async () => {
		const { client } = await connect(exampleRoot);
		const { isError, envelope } = await callTool(
			client,
			"list_page_objects",
			{},
		);

		expect(isError).toBe(false);
		expect(envelope.ok).toBe(true);
		const items = envelope.data as Array<{ name: string; kind: string }>;
		expect(items.length).toBeGreaterThanOrEqual(4);
		const checkout = items.find((item) => item.name === "CheckoutPage");
		expect(checkout).toBeDefined();
		expect(checkout?.kind).toMatch(/root/i);
	}, 30_000);

	it("get_page_object_tree resolves CheckoutPage with its list member", async () => {
		const { client } = await connect(exampleRoot);
		const { isError, envelope } = await callTool(
			client,
			"get_page_object_tree",
			{ class: "CheckoutPage" },
		);

		expect(isError).toBe(false);
		expect(envelope.ok).toBe(true);
		const data = envelope.data as {
			root: string;
			defs: Record<
				string,
				{
					className: string;
					members: Array<{ name: string; result: { kind: string } }>;
					methods: Array<{ signature: string }>;
				}
			>;
		};
		const rootDef = data.defs[data.root];
		expect(rootDef.className).toBe("CheckoutPage");
		expect(
			rootDef.members.some((member) => member.result.kind === "list"),
			"CheckoutPage must expose a ListPageObject member",
		).toBe(true);
		expect(rootDef.methods.length).toBeGreaterThan(0);
	}, 30_000);

	it("rejects a call with neither class nor file", async () => {
		const { client } = await connect(exampleRoot);
		const { isError, envelope } = await callTool(
			client,
			"get_page_object_tree",
			{},
		);

		expect(isError).toBe(true);
		expect(envelope.ok).toBe(false);
		expect(envelope.error?.code).toBe("invalid_input");
		expect(envelope.error?.hint).toContain("list_page_objects");
	}, 30_000);

	it("reports class_not_found with a hint for a typo'd class", async () => {
		const { client } = await connect(exampleRoot);
		const { isError, envelope } = await callTool(
			client,
			"get_page_object_tree",
			{ class: "CheckouPage" },
		);

		expect(isError).toBe(true);
		expect(envelope.error?.code).toBe("class_not_found");
		expect(envelope.error?.hint).toContain("list_page_objects");
	}, 30_000);

	it("get_testid_tree surfaces the dynamic CartItem_ pattern", async () => {
		const { client } = await connect(exampleRoot);
		const { isError, envelope } = await callTool(client, "get_testid_tree", {
			file: "src/components/CheckoutPage.tsx",
		});

		expect(isError).toBe(false);
		expect(envelope.ok).toBe(true);
		const serialized = JSON.stringify(envelope.data);
		expect(serialized).toContain("CartItem_");
		expect(serialized).toContain("PromoCodeInput");
	}, 30_000);

	it("map_coverage reports role selectors as unverifiable, never dead", async () => {
		const { client } = await connect(exampleRoot);
		const { isError, envelope } = await callTool(client, "map_coverage", {});

		expect(isError).toBe(false);
		expect(envelope.ok).toBe(true);
		const data = envelope.data as {
			summary: Record<string, number>;
			nonTestIdSelectors: Array<{ kind: string }>;
			deadSelectors: unknown[];
			uncoveredTestIds: Array<{ id: string | null }>;
		};
		expect(data.summary).toBeDefined();
		expect(
			data.nonTestIdSelectors.some((selector) => selector.kind === "role"),
			"role selectors must land in nonTestIdSelectors",
		).toBe(true);
		expect(data.deadSelectors).toHaveLength(0);
	}, 30_000);

	it("sees files written between two tool calls without a restart", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "ppo-live-"));
		mkdirSync(path.join(projectRoot, "e2e"), { recursive: true });
		const write = (name: string) =>
			writeFileSync(
				path.join(projectRoot, "e2e", `${name}.ts`),
				pageObjectSource(name),
				"utf8",
			);
		const names = async (client: Client): Promise<string[]> => {
			const { envelope } = await callTool(client, "list_page_objects", {});
			expect(envelope.ok).toBe(true);
			return (envelope.data as Array<{ name: string }>)
				.map((item) => item.name)
				.sort();
		};

		try {
			write("FirstPage");
			const { client } = await connect(projectRoot);
			// Builds the workspace; `create` does not revalidate, so no re-glob has
			// happened yet.
			expect(await names(client)).toEqual(["FirstPage"]);

			write("SecondPage");
			// Not a race against the 1s new-file throttle: that window is measured
			// from the last re-glob, and this is the first one this workspace runs,
			// so it rescans regardless of elapsed time. Locked by "re-globs on the
			// first revalidate however young the workspace is" in workspace.spec.ts.
			expect(await names(client)).toEqual(["FirstPage", "SecondPage"]);
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
		}
	}, 30_000);

	it("roots get_testid_tree at the requested component, not the file's first", async () => {
		await withProject(
			"ppo-multi-component-",
			{
				"src/Nested.tsx": [
					"export function Outer() {",
					'\treturn <div data-testid="OuterBox"><Inner /></div>;',
					"}",
					"",
					"export function Inner() {",
					'\treturn <span data-testid="InnerBox" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { isError, envelope } = await callTool(
					client,
					"get_testid_tree",
					{
						component: "Inner",
					},
				);

				expect(isError).toBe(false);
				const data = envelope.data as {
					roots: Array<{ tag: string; component: string }>;
				};
				// The tree is what `Inner` renders, exactly as `file` roots a file at
				// what its entry component renders — not a `<Inner/>` tag node lifted
				// out of somebody else's tree.
				expect(data.roots[0]).toMatchObject({
					tag: "span",
					component: "Inner",
				});
				// The engine roots where it is told, so there is no substitution left
				// to disclose, which is all `rootedAt` ever meant.
				expect(envelope.meta?.rootedAt).toBeUndefined();
				const serialized = JSON.stringify(data.roots);
				expect(serialized).toContain("InnerBox");
				expect(
					serialized,
					"Outer is the file's first component but was not the one requested",
				).not.toContain("OuterBox");
			},
		);
	}, 30_000);

	it("reports ambiguous_component when two files declare the requested name", async () => {
		await withProject(
			"ppo-duplicate-name-",
			{
				"src/ui/Button.tsx": [
					"export function Button() {",
					'\treturn <button data-testid="UiButton" />;',
					"}",
					"",
				].join("\n"),
				"src/legacy/Button.tsx": [
					"export function Button() {",
					'\treturn <button data-testid="LegacyButton" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const ambiguous = await callTool(client, "get_testid_tree", {
					component: "Button",
				});

				expect(ambiguous.isError).toBe(true);
				expect(ambiguous.envelope.error?.code).toBe("ambiguous_component");
				expect(
					ambiguous.envelope.error?.candidates,
					"both declaring files must be named, not silently one of them",
				).toEqual(["src/legacy/Button.tsx", "src/ui/Button.tsx"]);
				expect(ambiguous.envelope.error?.hint).toContain("file");

				// The hint has to actually work: `file` + `component` must resolve.
				const scoped = await callTool(client, "get_testid_tree", {
					component: "Button",
					file: "src/ui/Button.tsx",
				});

				expect(scoped.isError).toBe(false);
				const serialized = JSON.stringify(scoped.envelope.data);
				expect(serialized).toContain("UiButton");
				expect(serialized).not.toContain("LegacyButton");
			},
		);
	}, 30_000);

	it("roots a deeply nested component directly instead of asking for more depth", async () => {
		const files = {
			"src/Deep.tsx": [
				"export function Shell() {",
				'\treturn <div data-testid="ShellBox"><Middle /></div>;',
				"}",
				"",
				"export function Middle() {",
				'\treturn <section data-testid="MiddleBox"><Leaf /></section>;',
				"}",
				"",
				"export function Leaf() {",
				'\treturn <span data-testid="LeafBox" />;',
				"}",
				"",
			].join("\n"),
		};

		await withProject("ppo-depth-limit-", files, async (client) => {
			// Leaf renders two levels below the file's first component, but it is
			// also declared right there — so it is rooted directly and the depth
			// budget never enters into it.
			const shallow = await callTool(client, "get_testid_tree", {
				component: "Leaf",
				depth: 1,
			});

			expect(shallow.isError).toBe(false);
			const data = shallow.envelope.data as {
				roots: Array<{ tag: string; component: string }>;
			};
			expect(data.roots[0]).toMatchObject({ tag: "span", component: "Leaf" });
			const serialized = JSON.stringify(data.roots);
			expect(serialized).toContain("LeafBox");
			expect(serialized).not.toContain("ShellBox");
			expect(shallow.envelope.meta?.fidelity).toBe("full");
			expect(shallow.envelope.meta?.truncated).toBeUndefined();
		});
	}, 30_000);

	it("treats followComponents: false as a caller choice, not a budget cut", async () => {
		await withProject(
			"ppo-not-followed-",
			{
				"src/Deep.tsx": [
					"export function Shell() {",
					'\treturn <div data-testid="ShellBox"><Middle /></div>;',
					"}",
					"",
					"export function Middle() {",
					'\treturn <section data-testid="MiddleBox" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { isError, envelope } = await callTool(
					client,
					"get_testid_tree",
					{ component: "Shell", followComponents: false },
				);

				expect(isError).toBe(false);
				// It used to be faked as `depth: 1`, so the answer blamed a budget
				// that was never reached and reported the tree as truncated.
				expect(envelope.meta?.truncated).toBeUndefined();
				expect(envelope.meta?.fidelity).toBe("partial");
				expect(warningCodes(envelope)).not.toContain("depth-limit-reached");
				expect(warningCodes(envelope)).toContain("components-not-followed");
				expect(String(envelope.meta?.hint)).toContain("followComponents: true");
			},
		);
	}, 30_000);

	it("renders placement and each kind of hole distinctly in outline format", async () => {
		await withProject(
			"ppo-outline-labels-",
			{
				"src/Page.tsx": [
					'import { Gapped } from "@ext/ui";',
					"export function Page() {",
					"\treturn (",
					"\t\t<Gapped>",
					'\t\t\t<span data-testid="Slotted" />',
					"\t\t\t<Nested />",
					"\t\t</Gapped>",
					"\t);",
					"}",
					"",
					"export function Nested() {",
					'\treturn <b data-testid="Deep" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const passed = await callTool(client, "get_testid_tree", {
					component: "Page",
					format: "outline",
				});
				const text = String(passed.envelope.data);
				expect(text).toContain("slot");
				expect(text).toContain("external module");

				const stubbed = await callTool(client, "get_testid_tree", {
					component: "Page",
					format: "outline",
					depth: 1,
				});
				const stubbedText = String(stubbed.envelope.data);
				expect(stubbedText).toContain("depth limit");
				// Two different situations must not read as one `unresolved:` bucket.
				expect(stubbedText).not.toBe(text);
			},
		);
	}, 30_000);

	it("says the walk was depth-limited rather than implying the tree is whole", async () => {
		const files = {
			"src/Deep.tsx": [
				"export function Shell() {",
				'\treturn <div data-testid="ShellBox"><Middle /></div>;',
				"}",
				"",
				"export function Middle() {",
				'\treturn <section data-testid="MiddleBox"><Leaf /></section>;',
				"}",
				"",
				"export function Leaf() {",
				'\treturn <span data-testid="LeafBox" />;',
				"}",
				"",
			].join("\n"),
		};

		await withProject("ppo-depth-hint-", files, async (client) => {
			const shallow = await callTool(client, "get_testid_tree", {
				component: "Shell",
				depth: 1,
			});

			expect(shallow.isError).toBe(false);
			expect(shallow.envelope.meta?.fidelity).toBe("partial");
			expect(shallow.envelope.meta?.truncated).toBe(true);
			expect(String(shallow.envelope.meta?.hint)).toContain("depth");

			// The hint has to actually work.
			const deep = await callTool(client, "get_testid_tree", {
				component: "Shell",
				depth: 3,
			});
			expect(deep.envelope.meta?.fidelity).toBe("full");
			expect(JSON.stringify(deep.envelope.data)).toContain("LeafBox");
		});
	}, 30_000);

	it("counts stats over the returned tree, not the whole scan", async () => {
		await withProject(
			"ppo-rooted-stats-",
			{
				"src/Nested.tsx": [
					"export function Outer() {",
					'\treturn <div data-testid="OuterBox"><Inner /></div>;',
					"}",
					"",
					"export function Inner() {",
					'\treturn <span data-testid="InnerBox" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				type Payload = {
					roots: Array<{ testId?: unknown; children: unknown[] }>;
					stats: { nodes: number; testIds: number };
				};
				const countNodes = (nodes: Payload["roots"]): number =>
					nodes.reduce(
						(total, node) =>
							total + 1 + countNodes(node.children as Payload["roots"]),
						0,
					);

				const whole = await callTool(client, "get_testid_tree", {
					file: "src/Nested.tsx",
				});
				const wholeData = whole.envelope.data as Payload;
				expect(wholeData.stats.nodes).toBe(countNodes(wholeData.roots));
				expect(wholeData.stats.testIds).toBe(2);
				expect(whole.envelope.meta?.scanned).toBe(1);

				const rooted = await callTool(client, "get_testid_tree", {
					component: "Inner",
				});
				const rootedData = rooted.envelope.data as Payload;
				expect(rootedData.roots[0]).toMatchObject({ tag: "span" });
				expect(rootedData.stats.nodes).toBe(countNodes(rootedData.roots));
				expect(
					rootedData.stats.testIds,
					"OuterBox is outside the returned subtree and must not be counted",
				).toBe(1);
			},
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
