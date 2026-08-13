import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
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

async function instructions(): Promise<string> {
	const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
	const server = createMcpServer({ projectRoot: process.cwd() });
	const client = new Client({ name: "vitest", version: "0.0.0" });
	await server.connect(serverEnd);
	await client.connect(clientEnd);
	const text = client.getInstructions() ?? "";
	await client.close();
	await server.close();
	return text;
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

	it("quotes limits from the schemas rather than restating them", async () => {
		const text = await instructions();
		// The paging walk it describes has to be the one the schema allows.
		expect(mapCoverageInput.parse({}).limit).toBe(
			queryCoverageInput.parse({ coverageId: "x", bucket: "matched" }).limit,
		);
		expect(text).toContain("meta.nextOffset");
	});
});
