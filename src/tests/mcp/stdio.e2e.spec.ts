import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

/** Runs the built CLI to completion. Never spawns through a shell shim. */
function runCli(args: string[]): {
	status: number | null;
	stdout: string;
	stderr: string;
} {
	const result = spawnSync(process.execPath, [distCli, ...args], {
		encoding: "utf8",
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

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

	it("documents --playwright-config in the help text", () => {
		const help = runCli(["mcp", "--help"]);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("--playwright-config");
		expect(help.stdout).toContain("--assume-forwarded");
	});

	// The flag changes what "rendered" means in every coverage answer, so it has
	// to survive the whole path: argv, validation, server options, handler.
	it("carries --assume-forwarded through to the coverage report", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "ppo-e2e-assume-"));
		mkdirSync(path.join(root, "src"), { recursive: true });
		mkdirSync(path.join(root, "e2e"), { recursive: true });
		writeFileSync(
			path.join(root, "src", "Card.tsx"),
			"export default function Card(props: { children?: unknown }) {\n\treturn <div>{props.children as never}</div>;\n}\n",
		);
		writeFileSync(
			path.join(root, "src", "App.tsx"),
			'import Card from "./Card";\nexport function App() {\n\treturn <Card data-testid="Ghost" />;\n}\n',
		);
		writeFileSync(
			path.join(root, "e2e", "GhostPage.ts"),
			[
				'import type { Locator } from "@playwright/test";',
				'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
				"",
				"@RootSelector()",
				"export class GhostPage extends RootPageObject {",
				'\t@Selector("Ghost")',
				"\taccessor Ghost!: Locator;",
				"}",
				"",
			].join("\n"),
		);

		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [distCli, "mcp", "--project-root", root, "--assume-forwarded"],
		});
		const client = new Client({ name: "vitest-e2e", version: "0.0.0" });
		await client.connect(transport);

		try {
			const result = (await client.callTool({
				name: "map_coverage",
				arguments: {},
			})) as { content: Array<{ type: string; text: string }> };
			const text = result.content.find((block) => block.type === "text")?.text;
			const envelope = JSON.parse(text as string) as {
				ok: boolean;
				data: { summary: { assumedForwardedTestIds?: number } };
				meta?: Record<string, unknown>;
			};
			expect(envelope.ok).toBe(true);
			expect(envelope.meta?.assumeForwarded).toBe(true);
			expect(envelope.data.summary.assumedForwardedTestIds).toBe(1);
		} finally {
			await client.close();
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	// A server started against a directory that is not there stays up for the
	// whole session answering from an empty scope. Startup is the last moment a
	// human reads anything this process writes.
	it("refuses to start when --src-dir does not exist", () => {
		const result = runCli([
			"mcp",
			"--project-root",
			exampleRoot,
			"--src-dir",
			"does-not-exist",
		]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("does-not-exist");
		expect(result.stdout, "stdout is the JSON-RPC channel").toBe("");
	});

	it("refuses to start when --playwright-config does not exist", () => {
		const result = runCli([
			"mcp",
			"--project-root",
			exampleRoot,
			"--playwright-config",
			"nope.config.ts",
		]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("--playwright-config");
	});

	it("reads the config named by --playwright-config", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "ppo-e2e-config-"));
		mkdirSync(path.join(root, "config"), { recursive: true });
		mkdirSync(path.join(root, "src"), { recursive: true });
		writeFileSync(
			path.join(root, "config", "pw.ts"),
			'export default { use: { testIdAttribute: "data-pinned" } };\n',
		);
		writeFileSync(
			path.join(root, "src", "App.tsx"),
			'export function App() {\n\treturn <div data-pinned="AppRoot" />;\n}\n',
		);

		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [
				distCli,
				"mcp",
				"--project-root",
				root,
				"--playwright-config",
				"config/pw.ts",
			],
		});
		const client = new Client({ name: "vitest-e2e", version: "0.0.0" });
		await client.connect(transport);

		try {
			const result = (await client.callTool({
				name: "get_testid_tree",
				arguments: {},
			})) as { content: Array<{ type: string; text: string }> };
			const text = result.content.find((block) => block.type === "text")?.text;
			const envelope = JSON.parse(text as string) as {
				ok: boolean;
				meta?: Record<string, unknown>;
			};
			expect(envelope.ok).toBe(true);
			expect(envelope.meta?.attribute).toBe("data-pinned");
			expect(envelope.meta?.playwrightConfig).toBe("config/pw.ts");
		} finally {
			await client.close();
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);
});
