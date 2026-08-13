import { afterAll, describe, expect, it } from "vitest";
import {
	callTool,
	closeAllClients,
	connect,
	exampleRoot,
} from "./helpers/mcpClient";

afterAll(closeAllClients);

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
			// Explicit: this asserts the structured payload, which is what `json` is
			// for. The default is `outline` because most callers only read it.
			{ class: "CheckoutPage", format: "json" },
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

	/**
	 * The block is invaluable once and identical after: measured at 1,405 B of a
	 * 2,690 B response, 52% of it, re-sent on every call while the warnings
	 * beside it deduplicated. A repeat keeps the keys — they name which bases
	 * this tree uses, which is the part that varies — and drops the prose.
	 */
	it("sends the API prose once a session and the base names every time", async () => {
		const { client } = await connect(exampleRoot);

		const first = await callTool(client, "get_page_object_tree", {
			class: "CheckoutPage",
			format: "outline",
		});
		const firstHints = first.envelope.meta?.apiHints as Record<string, string>;
		expect(firstHints.ListPageObject).toContain(".first()");

		const second = await callTool(client, "get_page_object_tree", {
			class: "CheckoutPage",
			format: "outline",
		});
		// Same bases named, no prose — and in its own field, so `apiHints` is
		// always an object of prose or absent. A field that changed type between
		// calls would break a consumer that parses the values.
		expect(second.envelope.meta?.apiHints).toBeUndefined();
		expect(second.envelope.meta?.apiHintsSent).toEqual([
			"members",
			"RootPageObject",
			"PageObject",
			"ListPageObject",
		]);
		expect(second.text.length).toBeLessThan(first.text.length);
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
				format: "json",
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
});
