import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readPlaywrightConfig } from "../../../analysis/config/playwrightConfig";
import { Workspace } from "../../../analysis/workspace";
import { exampleWorkspace } from "../helpers/example";

const temporaryRoots: string[] = [];

/**
 * Playwright configs live outside the tsconfig `include` in practice, so they
 * have to be read straight off disk. That makes a real temp directory the
 * honest fixture here.
 */
function workspaceWithConfig(files: Record<string, string>): Workspace {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppo-pwcfg-"));
	temporaryRoots.push(root);
	for (const [relativePath, contents] of Object.entries(files)) {
		const absolute = path.join(root, relativePath);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, contents, "utf8");
	}
	Workspace.reset();
	return Workspace.acquire({ projectRoot: root });
}

afterAll(() => {
	for (const root of temporaryRoots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
	Workspace.reset();
});

describe("readPlaywrightConfig", () => {
	it("reads a defineConfig call", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": [
				'import { defineConfig } from "@playwright/test";',
				"export default defineConfig({",
				'  testDir: "./e2e",',
				'  use: { testIdAttribute: "data-qa" },',
				"});",
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.configFile).toBe("playwright.config.ts");
		expect(info.testDir).toBe("./e2e");
		expect(info.testIdAttribute).toBe("data-qa");
		expect(info.notes).toEqual([]);
	});

	it("reads a bare object default export", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts":
				'export default { testDir: "./tests", use: { testIdAttribute: "qa-id" } };',
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testDir).toBe("./tests");
		expect(info.testIdAttribute).toBe("qa-id");
	});

	it("follows an identifier default export one hop", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": [
				'const config = { testDir: "./e2e", use: { testIdAttribute: "x-id" } };',
				"export default config;",
			].join("\n"),
		});
		expect(readPlaywrightConfig(ws).testIdAttribute).toBe("x-id");
	});

	it("returns undefined when testIdAttribute is absent (the example's shape)", () => {
		const info = readPlaywrightConfig(exampleWorkspace());
		expect(info.configFile).toBe("playwright.config.ts");
		expect(info.testIdAttribute).toBeUndefined();
		expect(info.testDir).toBe("./e2e");
		expect(info.projectOverrides).toEqual([]);
		expect(exampleWorkspace().testIdAttribute()).toEqual({
			attribute: "data-testid",
			source: "default",
		});
	});

	it("refuses to evaluate a non-literal attribute and says where it is", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": [
				'import { defineConfig } from "@playwright/test";',
				"export default defineConfig({ use: { testIdAttribute: process.env.X } });",
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBeUndefined();
		const note = info.notes.find(
			(diagnostic) => diagnostic.code === "testid-attribute-unresolved",
		);
		expect(note?.loc?.file).toBe("playwright.config.ts");
		expect(note?.loc?.line).toBe(2);
	});

	it("hints when `use` only has a spread", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": [
				'import { defineConfig, devices } from "@playwright/test";',
				'export default defineConfig({ use: { ...devices["Desktop Chrome"] } });',
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.notes.map((diagnostic) => diagnostic.code)).toContain(
			"testid-attribute-maybe-spread",
		);
	});

	it("stays quiet about a spread when the attribute is also present", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": [
				'import { defineConfig, devices } from "@playwright/test";',
				"export default defineConfig({",
				'  use: { ...devices["Desktop Chrome"], testIdAttribute: "data-qa" },',
				"});",
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBe("data-qa");
		expect(info.notes).toEqual([]);
	});

	it("records project-level overrides without applying them", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": [
				'import { defineConfig } from "@playwright/test";',
				"export default defineConfig({",
				'  use: { testIdAttribute: "data-top" },',
				'  projects: [{ name: "legacy", use: { testIdAttribute: "data-old" } }],',
				"});",
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBe("data-top");
		expect(info.projectOverrides).toEqual([
			{
				project: "legacy",
				testIdAttribute: "data-old",
				loc: expect.objectContaining({ file: "playwright.config.ts" }),
			},
		]);
		expect(info.notes.map((diagnostic) => diagnostic.code)).toContain(
			"testid-attribute-project-override",
		);
	});

	it("searches the alternative extensions and nested test directories", () => {
		expect(
			readPlaywrightConfig(
				workspaceWithConfig({
					"playwright.config.mts": 'export default { testDir: "./a" };',
				}),
			).configFile,
		).toBe("playwright.config.mts");

		expect(
			readPlaywrightConfig(
				workspaceWithConfig({
					"e2e/playwright.config.cjs": 'export default { testDir: "./b" };',
				}),
			).configFile,
		).toBe("e2e/playwright.config.cjs");
	});

	it("accepts an explicit path", () => {
		const ws = workspaceWithConfig({
			"config/pw.ts": 'export default { testDir: "./explicit" };',
		});
		expect(readPlaywrightConfig(ws, "config/pw.ts").testDir).toBe("./explicit");
	});

	it("reports an unrecognised default export shape", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": "export default buildConfig();",
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBeUndefined();
		expect(info.notes.map((diagnostic) => diagnostic.code)).toContain(
			"config-shape-unrecognized",
		);
	});

	it("reports a missing config as an info note, not an error", () => {
		const ws = workspaceWithConfig({ "src/a.ts": "export const a = 1;" });
		const info = readPlaywrightConfig(ws);
		expect(info.configFile).toBeNull();
		expect(info.notes[0]).toMatchObject({
			code: "playwright-config-not-found",
			severity: "info",
		});
	});
});
