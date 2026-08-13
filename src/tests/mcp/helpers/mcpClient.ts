import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect } from "vitest";
import type { McpServerOptions } from "../../../mcp/options";
import { MAX_BUCKET_LIMIT } from "../../../mcp/schemas";

/** The real schema ceiling, imported so the test cannot drift from it. */
export const MAX_BUCKET_PAGE = MAX_BUCKET_LIMIT;

import { createMcpServer } from "../../../mcp/server";

/**
 * In-process integration tests: a real Client talks to the real server over
 * a linked in-memory transport pair, with the analysis engine running against
 * the repo's own example/ app.
 */

export const exampleRoot = path.resolve(process.cwd(), "example");

/** A template hole in fixture *source*, assembled so it is not one here. */
export const hole = (name: string): string => `\${${name}}`;

export type ClientHandle = { client: Client; close: () => Promise<void> };
export const openClients: ClientHandle[] = [];

export async function connect(
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

export async function closeAllClients(): Promise<void> {
	for (const handle of openClients.splice(0)) {
		await handle.close().catch(() => {});
	}
}

/** Minimal page object the discovery pass recognises, written to a temp repo. */
export function pageObjectSource(className: string): string {
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

export function writeFile(root: string, rel: string, body: string): void {
	const full = path.join(root, rel);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, body, "utf8");
}

/** Spins up a throwaway repo with `files`, connects, runs `body`, cleans up. */
export async function withProject<T>(
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

export interface Envelope {
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
export function warningCodes(envelope: Envelope): string[] {
	const warnings = envelope.meta?.warnings as
		| Array<{ code: string }>
		| undefined;
	return (warnings ?? []).map((warning) => warning.code);
}

export async function callTool(
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

export function manyPageObjects(count: number, fat = false): string {
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
