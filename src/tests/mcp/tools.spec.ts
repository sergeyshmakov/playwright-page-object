import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, describe, expect, it } from "vitest";
import type { McpServerOptions } from "../../mcp/options";
import { MAX_RESPONSE_BYTES } from "../../mcp/respond";
import { createMcpServer } from "../../mcp/server";
import { coverageShrinkHint } from "../../mcp/tools";

/**
 * In-process integration tests: a real Client talks to the real server over
 * a linked in-memory transport pair, with the analysis engine running against
 * the repo's own example/ app.
 */

const exampleRoot = path.resolve(process.cwd(), "example");

/** A template hole in fixture *source*, assembled so it is not one here. */
const hole = (name: string): string => `\${${name}}`;

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
	body: (client: Client, root: string) => Promise<T>,
	options: Partial<McpServerOptions> = {},
): Promise<T> {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	try {
		for (const [rel, contents] of Object.entries(files)) {
			writeFile(root, rel, contents);
		}
		const { client } = await connect(root, options);
		return await body(client, root);
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
): Promise<{ isError: boolean; envelope: Envelope; text: string }> {
	const result = (await client.callTool({ name, arguments: args })) as {
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
	};
	const text = result.content.find((block) => block.type === "text")?.text;
	expect(text, "tool must return a text block").toBeDefined();
	return {
		isError: result.isError === true,
		envelope: JSON.parse(text as string) as Envelope,
		// The wire bytes, for anything asserting against the response cap.
		text: text as string,
	};
}

describe("MCP server over in-memory transport", () => {
	it("lists exactly five read-only tools with substantial descriptions", async () => {
		const { client } = await connect(exampleRoot);
		const { tools } = await client.listTools();

		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"get_page_object_tree",
			"get_testid_tree",
			"list_page_objects",
			"map_coverage",
			"query_coverage",
		]);

		// The spec requires a tool handing out an opaque handle to state the
		// handle's lifetime, and the tool that spends it to say the same. An
		// agent that cannot tell a dead id from a wrong one loops.
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		for (const name of ["map_coverage", "query_coverage"]) {
			expect(byName.get(name)?.description, name).toContain("10 minutes");
			expect(byName.get(name)?.description, name).toContain("expired_handle");
		}

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

	/**
	 * The tree is a chain of names; the calls that walk it are not in the tree.
	 * A page object's inherited library helpers are deliberately not repeated on
	 * every class, so without this block a reader has the whole selector graph
	 * and still cannot write `await checkoutPage.CartItems.first().waitVisible()`.
	 */
	it("ships the runtime API of every base the tree uses", async () => {
		const { client } = await connect(exampleRoot);
		const { envelope } = await callTool(client, "get_page_object_tree", {
			class: "CheckoutPage",
		});

		const hints = envelope.meta?.apiHints as Record<string, string>;
		expect(Object.keys(hints)).toEqual([
			"members",
			"RootPageObject",
			"PageObject",
			"ListPageObject",
		]);
		// The four things the example spec does that the tree cannot express.
		expect(hints.RootPageObject).toContain("new CheckoutPage(page)");
		expect(hints.members).toContain(".$");
		expect(hints.PageObject).toContain(".waitVisible()");
		expect(hints.ListPageObject).toContain(".first()");
	}, 30_000);

	it("ships the same API block with the outline format", async () => {
		const { client } = await connect(exampleRoot);
		const { envelope } = await callTool(client, "get_page_object_tree", {
			class: "CheckoutPage",
			format: "outline",
		});

		expect(typeof envelope.data).toBe("string");
		// `outline` is the format an agent is told to prefer, so it is the one
		// that must not be the cheaper answer in the way that matters.
		expect(
			Object.keys(envelope.meta?.apiHints as Record<string, string>),
		).toContain("ListPageObject");
		// And the fact that decides the test's first line: this suite binds
		// CheckoutPage as a fixture, so `new CheckoutPage(page)` is the wrong
		// opening. JSON has always carried it; the outline used to drop it.
		expect(envelope.data as string).toContain("fixture: checkoutPage");
	}, 30_000);

	/**
	 * The engine memoizes the tree and hands the same object to every caller, so
	 * `includeMethods: false` must not be able to trim it. It used to delete the
	 * methods in place, which — once the cache existed — silently emptied the
	 * `methods` list of every later call in the session.
	 */
	it("includeMethods:false does not strip methods from later calls", async () => {
		const { client } = await connect(exampleRoot);
		const methodCount = async (includeMethods: boolean): Promise<number> => {
			const { envelope } = await callTool(client, "get_page_object_tree", {
				class: "CheckoutPage",
				includeMethods,
			});
			const data = envelope.data as {
				root: string;
				defs: Record<string, { methods: unknown[] }>;
			};
			return data.defs[data.root].methods.length;
		};

		const full = await methodCount(true);
		expect(full).toBeGreaterThan(0);
		expect(await methodCount(false)).toBe(0);
		expect(await methodCount(true)).toBe(full);
	}, 30_000);

	/**
	 * A control declares no page object `list_page_objects` would show, so the
	 * lookup has to widen to the controls-inclusive index to find its file. The
	 * handler consults the plain index first — the one every other call already
	 * built — so this is the path that proves the widening still happens.
	 */
	it("map_coverage scopes to a file that declares only a control", async () => {
		const { client } = await connect(exampleRoot);
		const { isError, envelope } = await callTool(client, "map_coverage", {
			file: "e2e/page-objects/controls/ButtonControl.ts",
			buckets: [],
		});
		expect(isError).toBe(false);
		expect(envelope.ok).toBe(true);
		expect(envelope.data).toHaveProperty("summary");
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

	// Both discriminators have to run on this path. A typo is answered by edit
	// distance; a partial name is four edits away and is answered only by the
	// substring pass, which this tool did not have — so `class: "Checkout"` came
	// back with no suggestions while map_coverage answered the same question.
	it("reports class_not_found with suggestions for a typo and for a partial", async () => {
		const { client } = await connect(exampleRoot);

		const typo = await callTool(client, "get_page_object_tree", {
			class: "CheckouPage",
		});
		expect(typo.isError).toBe(true);
		expect(typo.envelope.error?.code).toBe("class_not_found");
		expect(typo.envelope.error?.hint).toContain("list_page_objects");
		expect(typo.envelope.error?.suggestions).toContain("CheckoutPage");

		const partial = await callTool(client, "get_page_object_tree", {
			class: "Checkout",
		});
		expect(partial.envelope.error?.code).toBe("class_not_found");
		expect(partial.envelope.error?.suggestions).toContain("CheckoutPage");
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

	// `tree-partial` says where the *walk* stopped, in terms of `roots`. A
	// `testId` lookup ships occurrences read off the flat inventory, which is
	// complete in every fidelity mode, so the caveat landed on the one part of
	// the analysis it cannot apply to.
	it("does not caveat a testId lookup with the shape of a tree it did not return", async () => {
		await withProject(
			"ppo-lookup-warnings-",
			{
				"src/App.tsx": [
					'import { Gapped } from "@ext/ui";',
					"export function App() {",
					'\treturn <Gapped><span data-testid="Slotted" /></Gapped>;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const codes = (envelope: { meta?: Record<string, unknown> }) =>
					((envelope.meta?.warnings ?? []) as Array<{ code: string }>).map(
						(warning) => warning.code,
					);

				// The tree really is partial: the wrapper is an unresolvable module.
				const tree = await callTool(client, "get_testid_tree", {
					component: "App",
				});
				expect(tree.envelope.meta?.fidelity).toBe("partial");
				expect(codes(tree.envelope)).toContain("tree-partial");

				const lookup = await callTool(client, "get_testid_tree", {
					testId: "Slotted",
				});
				expect(lookup.isError).toBe(false);
				expect(codes(lookup.envelope)).not.toContain("tree-partial");

				// Same reasoning, one layer down: coverage ships no roots either.
				const coverage = await callTool(client, "map_coverage", {
					buckets: [],
				});
				expect(codes(coverage.envelope)).not.toContain("tree-partial");
			},
		);
	}, 30_000);

	// The tree carries every branch of a static choice, and outline is the format
	// an agent actually reads. Printing only the first branch there said
	// `data-testid={big ? "Main" : "Alt"}` renders `Main`, so a correct selector
	// for `Alt` read as invented — the same disagreement between the tree and the
	// flat inventory that `testIdAlternatives` exists to close.
	it("shows every branch of a static choice in outline format", async () => {
		await withProject(
			"ppo-outline-alternatives-",
			{
				"src/App.tsx": [
					"export function App({ big }: { big: boolean }) {",
					'\treturn <div data-testid={big ? "Main" : "Alt"} />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const outline = await callTool(client, "get_testid_tree", {
					component: "App",
					format: "outline",
				});
				const text = String(outline.envelope.data);
				expect(text).toContain("Main");
				expect(text).toContain("Alt");

				const json = await callTool(client, "get_testid_tree", {
					component: "App",
				});
				expect(JSON.stringify(json.envelope.data)).toContain(
					"testIdAlternatives",
				);
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

	// The breakdown existed only as prose, inside `fidelityReason` and the
	// `tree-partial` warning. A caller that wants to branch on where the holes
	// are had to parse an English sentence.
	it("ships the unresolved breakdown as counts, agreeing with the prose", async () => {
		await withProject(
			"ppo-unresolved-stats-",
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
				const partial = await callTool(client, "get_testid_tree", {
					component: "Shell",
					followComponents: false,
				});
				const stats = (
					partial.envelope.data as { stats: Record<string, unknown> }
				).stats;
				expect(stats.unresolved).toBe(1);
				expect(stats.unresolvedByReason).toEqual({ "not-followed": 1 });
				// One source of truth: the sentence is rendered from these counts.
				expect(String(partial.envelope.meta?.fidelityReason)).toContain(
					"not-followed ×1",
				);

				// A complete tree says so with a zero and no breakdown at all, rather
				// than with an empty object nobody has to read.
				const whole = await callTool(client, "get_testid_tree", {
					component: "Shell",
				});
				const wholeStats = (
					whole.envelope.data as { stats: Record<string, unknown> }
				).stats;
				expect(whole.envelope.meta?.fidelity).toBe("full");
				expect(wholeStats.unresolved).toBe(0);
				expect(wholeStats.unresolvedByReason).toBeUndefined();
			},
		);
	}, 30_000);

	// A typo'd `file` used to be discarded in silence: the entry matched nothing,
	// the walk fell back to a flat inventory of the whole scan, and a real app
	// answered `too_large` with advice to scope the call with `file` — which the
	// caller had just done. An agent loops there.
	it("rejects a typo'd get_testid_tree file with ranked suggestions", async () => {
		await withProject(
			"ppo-testid-file-typo-",
			{
				"src/components/GuestItem/GuestItemInfo.tsx": [
					"export function GuestItemInfo() {",
					'\treturn <div data-testid="GuestItemBox"><span data-testid="GuestName" /></div>;',
					"}",
					"",
				].join("\n"),
				"src/App.tsx": [
					'import { GuestItemInfo } from "./components/GuestItem/GuestItemInfo";',
					"export function App() {",
					'\treturn <main data-testid="AppRoot"><GuestItemInfo /></main>;',
					"}",
					"",
				].join("\n"),
			},
			async (client, root) => {
				const typo = await callTool(client, "get_testid_tree", {
					file: "src/components/GuestItem/GuestItemInf.tsx",
				});

				expect(typo.isError).toBe(true);
				expect(typo.envelope.error?.code).toBe("file_not_found");
				expect(typo.envelope.error?.suggestions).toContain(
					"src/components/GuestItem/GuestItemInfo.tsx",
				);
				expect(
					JSON.stringify(typo.envelope),
					"a scope that matched nothing must not ship the whole-app inventory",
				).not.toContain("AppRoot");

				// The suggested path has to work, and has to still scope the walk.
				const good = await callTool(client, "get_testid_tree", {
					file: "src/components/GuestItem/GuestItemInfo.tsx",
				});
				expect(good.isError).toBe(false);
				const serialized = JSON.stringify(good.envelope.data);
				expect(serialized).toContain("GuestName");
				expect(serialized).not.toContain("AppRoot");

				// Agents paste the path their editor shows them, here too.
				const absolute = await callTool(client, "get_testid_tree", {
					file: path.join(
						root,
						"src",
						"components",
						"GuestItem",
						"GuestItemInfo.tsx",
					),
				});
				expect(absolute.isError).toBe(false);
				expect(String(absolute.envelope.meta?.note)).toContain(
					"src/components/GuestItem/GuestItemInfo.tsx",
				);
			},
		);
	}, 30_000);

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
	function manyPageObjects(count: number, fat = false): string {
		const lines = [
			'import type { Locator } from "@playwright/test";',
			'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
			"",
		];
		// `limit` maxes out at 500, so a response can only outgrow the cap through
		// entry SIZE, not entry count. `fat` gives each summary the doc string and
		// the long names that a real repository has.
		// docSummary keeps the first sentence up to 160 chars, so this is written
		// to just fill that: a wide entry is the point of the fixture.
		const doc =
			"Screen page object generated for a response-size test, carrying a summary sentence of the width a documented page object in a real repository has.";
		for (let index = 0; index < count; index += 1) {
			const name = fat
				? `GeneratedAdministrationSettingsAndPreferencesScreenNumber${index}SectionDetailPage`
				: `GeneratedScreenNumber${index}Page`;
			if (fat) {
				lines.push(`/** ${doc} */`);
			}
			lines.push(
				`@RootSelector("AdministrationSettingsAndPreferencesScreen${index}RootContainerElement")`,
				`export class ${name} extends RootPageObject {`,
				`\t@Selector("AdministrationSettingsAndPreferencesScreen${index}PrimaryInputFieldElement")`,
				"\taccessor Input!: Locator;",
				"}",
				"",
			);
		}
		return lines.join("\n");
	}

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
				expect(envelope.meta?.ignored).toEqual(["includeUnused"]);

				// An empty list is a list: the cheapest coverage call there is, and
				// the one that used to return all six buckets instead of none.
				const none = await callTool(client, "map_coverage", { buckets: [] });
				const bare = none.envelope.data as Record<string, unknown>;
				expect(Object.keys(bare).sort()).toEqual(["scope", "summary"]);
				expect(none.envelope.meta?.ignored).toEqual(["includeUnused"]);
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
			for (let index = 0; index < count; index += 1) {
				const name = `DeliberatelyDescriptiveDeadSelectorName${String(index).padStart(4, "0")}`;
				lines.push(`\t@Selector("${name}")`, `\taccessor ${name}!: Locator;`);
			}
			lines.push("}", "");
			return lines.join("\n");
		}

		const fatRepo = {
			"e2e/Fat.ts": fatPageObject(1000),
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
					{ buckets: ["deadSelectors"], limit: 1000 },
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
				expect(data.summary.deadSelectors).toBe(1001);
				expect(data.scope).toBeDefined();
				expect(data.deadSelectors.length).toBeGreaterThan(0);
				expect(data.deadSelectors.length).toBeLessThan(1001);

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
						limit: 1000,
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
				expect(everTrimmed, "a 1001-entry page cannot have fit whole").toBe(
					true,
				);
				expect(seen).toHaveLength(1001);
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
					{ limit: 1000 },
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
