import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

/**
 * End-to-end: spawns the BUILT CLI (`node dist/cli.js mcp`) and talks to it
 * through a real stdio client. Proves the bin wiring, the lazy self-reference
 * require of dist/mcp.js, and a full tools/call round-trip.
 *
 * Requires `npm run build` first; skipped when dist/cli.js is absent so plain
 * `vitest` runs stay green locally. CI builds before testing.
 */

const distCli = path.resolve(process.cwd(), "dist", "cli.js");
const exampleRoot = path.resolve(process.cwd(), "example");

describe.skipIf(!existsSync(distCli))("MCP server over spawned stdio", () => {
	it("initializes, lists tools, and answers a real tools/call", async () => {
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [distCli, "mcp", "--project-root", exampleRoot],
		});
		const client = new Client({ name: "vitest-e2e", version: "0.0.0" });
		await client.connect(transport);

		try {
			const { tools } = await client.listTools();
			expect(tools).toHaveLength(4);

			const result = (await client.callTool({
				name: "get_page_object_tree",
				arguments: { class: "CheckoutPage", format: "outline" },
			})) as { content: Array<{ type: string; text: string }> };

			const text = result.content.find((block) => block.type === "text")?.text;
			expect(text).toBeDefined();
			const envelope = JSON.parse(text as string) as {
				ok: boolean;
				data: string;
			};
			expect(envelope.ok).toBe(true);
			expect(envelope.data).toContain("CheckoutPage");
		} finally {
			await client.close();
		}
	}, 60_000);
});
