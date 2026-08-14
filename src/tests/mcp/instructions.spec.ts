import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
	LIBRARY_BASE_CLASSES,
	MEMBER_DECORATORS,
	ROOT_DECORATORS,
} from "../../analysis/page-objects/libraryImports";
import {
	getPageObjectTreeInput,
	getTestIdTreeInput,
	mapCoverageInput,
	queryCoverageInput,
} from "../../mcp/schemas";
import { createMcpServer } from "../../mcp/server";

/**
 * The server's `instructions` block and its five tool descriptions are product
 * text: they are resident in every session's context and are the only thing an
 * agent reads before its first call. They are also prose about behaviour
 * defined elsewhere, which is exactly the shape that drifts.
 *
 * It has drifted twice. The `format` default was flipped to `outline` and the
 * instructions went on saying "use the default JSON" for four commits, through
 * three audits. A sentence promising that no response is ever refused for being
 * long outlived the refusal by longer than that.
 *
 * These tests are the cheap half of the fix — the other half is deriving the
 * text from the constant, which `server.ts` now does for the format default and
 * `handles.ts` already did for the handle lifetime. Where a claim cannot be
 * derived, it gets asserted here.
 */

async function withClient<T>(read: (client: Client) => T | Promise<T>) {
	const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
	const server = createMcpServer({ projectRoot: process.cwd() });
	const client = new Client({ name: "vitest", version: "0.0.0" });
	await server.connect(serverEnd);
	await client.connect(clientEnd);
	try {
		return await read(client);
	} finally {
		await client.close();
		await server.close();
	}
}

async function instructions(): Promise<string> {
	return withClient((client) => client.getInstructions() ?? "");
}

/** Tool name to description, for the claims that live in tool text. */
async function tools(): Promise<Map<string, string>> {
	return withClient(async (client) => {
		const listed = await client.listTools();
		return new Map(
			listed.tools.map((tool) => [tool.name, tool.description ?? ""]),
		);
	});
}

describe("server instructions", () => {
	it("names the format default the schema actually applies", async () => {
		const text = await instructions();
		const treeDefault = getTestIdTreeInput.parse({}).format;
		const objectDefault = getPageObjectTreeInput.parse({}).format;

		// One sentence covers both tools, so they had better agree.
		expect(objectDefault).toBe(treeDefault);
		expect(text).toContain(`default to format:"${treeDefault}"`);
		// And it must not describe the other one as the default.
		const other = treeDefault === "outline" ? "json" : "outline";
		expect(text).not.toContain(`the default ${other.toUpperCase()}`);
		expect(text).not.toContain(`the default ${other}`);
	});

	/**
	 * Only the two coverage tools trim; the other three still return `too_large`
	 * (`respond.ts`), and the docs document that. An unqualified promise here
	 * told every agent not to plan for an error it can get.
	 */
	it("does not promise that no response is ever refused", async () => {
		const text = await instructions();
		expect(text).not.toMatch(/No response is ever refused/i);
		expect(text).toContain("too_large");
	});

	/**
	 * The scope paragraph exists because an agent that gets `[]` from
	 * `list_page_objects` on an undecorated repository draws one of two
	 * conclusions, and the wrong one is expensive: "this repo has no page
	 * objects, I will write my own" rather than "this server cannot see them".
	 * It also has to survive a decorator being added to the library — the prose
	 * names two families by wildcard, so this checks the wildcards still cover
	 * every decorator that actually makes a class visible.
	 */
	it("says which classes the page-object tools can see", async () => {
		const text = await instructions();
		const listDescription = (await tools()).get("list_page_objects") ?? "";

		// Both texts answer "what is indexed", so both have to stay complete.
		// `ListRootSelector` was missing from each when this test was written.
		for (const where of [text, listDescription]) {
			for (const decorator of [...MEMBER_DECORATORS, ...ROOT_DECORATORS]) {
				const named = where.includes(`@${decorator}`);
				// `SelectorByRole` is covered by `@SelectorBy*`, `RootSelectorByRole`
				// by `@RootSelectorBy*`. A new `@FooSelector` would be covered by
				// neither and fail here, which is the point.
				const prefix = decorator.startsWith("Root") ? "Root" : "";
				const wildcarded =
					/^(Root)?SelectorBy/.test(decorator) &&
					where.includes(`@${prefix}SelectorBy*`);
				expect(named || wildcarded, `${decorator} is not covered`).toBe(true);
			}
		}

		// Absence of an index must not read as absence of page objects.
		expect(text).toMatch(/not that the repository has no page objects/i);
	});

	/**
	 * Decorators are one of four discovery paths, not the boundary.
	 * `discoverPageObjects` also registers a class for extending a library base
	 * class, for a `createFixtures` binding, and for being passed as a factory
	 * argument — so an undecorated class that only extends `PageObject` is
	 * indexed. The first draft of the scope paragraph said "only classes whose
	 * accessors carry selector decorators", which would have told every session
	 * that a whole style of page object is invisible when it is not.
	 */
	it("describes every discovery path, not just decorators", async () => {
		const text = await instructions();
		const listDescription = (await tools()).get("list_page_objects") ?? "";

		for (const where of [text, listDescription]) {
			// The base classes, named individually.
			for (const base of LIBRARY_BASE_CLASSES) {
				expect(where, `${base} is not mentioned`).toContain(base);
			}
			expect(where).toContain("createFixtures");
		}

		// And the instructions must not re-assert the boundary that was wrong.
		expect(text).not.toMatch(/see only classes whose accessors/i);
	});

	/**
	 * The claim that the other tools work without decorators is only useful if
	 * it names the flag that makes it true of `map_coverage`, and that flag's
	 * default is the whole reason the sentence exists.
	 */
	it("names the flag that makes coverage work without decorators", async () => {
		const text = await instructions();
		expect(mapCoverageInput.parse({}).includeRawLocators).toBe(false);
		expect(text).toContain("includeRawLocators: true");
		expect(text).toContain("get_testid_tree reads JSX/TSX");
	});

	it("quotes limits from the schemas rather than restating them", async () => {
		const text = await instructions();
		// The paging walk it describes has to be the one the schema allows.
		expect(mapCoverageInput.parse({}).limit).toBe(
			queryCoverageInput.parse({ coverageId: "x", bucket: "matched" }).limit,
		);
		expect(text).toContain("meta.nextOffset");
	});
});
