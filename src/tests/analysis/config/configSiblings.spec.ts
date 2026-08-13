import { afterAll, describe, expect, it } from "vitest";
import { MAX_CONFIG_CANDIDATES } from "../../../analysis/config/configDiscovery";
import { readPlaywrightConfig } from "../../../analysis/config/playwrightConfig";
import {
	type Workspace,
	type WorkspaceOptions,
	WorkspacePool,
} from "../../../analysis/workspace";
import { cleanupScratchRoots, scratchRepo } from "../helpers/onDisk";

/**
 * Playwright configs live outside the tsconfig `include` in practice, so they
 * have to be read straight off disk. That makes a real temp directory the
 * honest fixture here.
 */

/** One per spec file, so nothing leaks between them. */
const pool = new WorkspacePool();
function workspaceWithConfig(
	files: Record<string, string>,
	options: Partial<WorkspaceOptions> = {},
): Workspace {
	const root = scratchRepo(files, { prefix: "ppo-pwcfg-" });
	pool.clear();
	return pool.acquire({ projectRoot: root, ...options });
}

afterAll(() => {
	cleanupScratchRoots();
	pool.clear();
});

/**
 * Sibling configs: reported, never applied.
 *
 * Discovery ranks every `playwright*.config.*` in the repository, and two of
 * them may have nothing to do with each other — an E2E config and a
 * `playwright-ct.config.ts` for component tests run different suites under
 * different attributes. Statically that is the same shape as a repository which
 * splits `use` into a base file CI points at, so borrowing the neighbour's value
 * was a coin flip: on the second shape it scanned every source with an attribute
 * the suite never uses, while the metadata went on naming the chosen config.
 *
 * The configs the chosen one really is built from — imported, spread, merged —
 * are layers, and those still apply. A sibling only gets a warning naming it.
 */
describe("sibling configs", () => {
	it("reports a sibling's attribute without applying it", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": 'export default { testDir: "./e2e" };',
			"playwright.base.config.ts":
				'export default { use: { testIdAttribute: "data-tid" } };',
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBeUndefined();
		expect(info.testIdAttributeFrom).toBeUndefined();
		const note = info.notes.find(
			(diagnostic) => diagnostic.code === "testid-attribute-sibling",
		);
		expect(note?.severity).toBe("warning");
		expect(note?.data).toMatchObject({
			attribute: "data-tid",
			from: "playwright.base.config.ts",
			applied: false,
		});
		expect(note?.message).toContain("playwright.base.config.ts");
	});

	// The shape the old probe got wrong. A component-test config has no runtime
	// relationship to the E2E suite, and `data-ct-id` would have been applied to
	// every tree and coverage answer.
	it("never scans with an unrelated component-test config's attribute", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": 'export default { testDir: "./e2e" };',
			"playwright-ct.config.ts":
				'export default { use: { testIdAttribute: "data-ct-id" } };',
		});
		expect(ws.testIdAttribute()).toEqual({
			attribute: "data-testid",
			source: "default",
		});
	});

	// What replaces the borrowed value: the census says the assumed attribute
	// appears nowhere, and the sibling note says which file to point at.
	it("leaves the census to flag the attribute and names the file to check", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": 'export default { testDir: "./e2e" };',
			"playwright.base.config.ts":
				'export default { use: { testIdAttribute: "data-tid" } };',
			"src/App.tsx":
				'export const App = () => <div data-tid="A"><b data-tid="B" /></div>;',
		});
		const codes = ws.environmentWarnings().map((diagnostic) => diagnostic.code);
		expect(codes).toContain("attribute-mismatch");
		expect(codes).toContain("testid-attribute-sibling");
	});

	it("names both siblings when they disagree, and applies neither", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": 'export default { testDir: "./e2e" };',
			"playwright.a.config.ts":
				'export default { use: { testIdAttribute: "data-a" } };',
			"playwright.b.config.ts":
				'export default { use: { testIdAttribute: "data-b" } };',
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBeUndefined();
		const note = info.notes.find(
			(diagnostic) => diagnostic.code === "testid-attribute-conflict",
		);
		expect(note?.data?.attribute).toBe("data-a");
		expect(note?.data?.other).toBe("data-b");
	});

	// A caller who names a config has answered the question the probe asks.
	it("does not read siblings when the config was named explicitly", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": 'export default { testDir: "./e2e" };',
			"playwright.base.config.ts":
				'export default { use: { testIdAttribute: "data-tid" } };',
		});
		const info = readPlaywrightConfig(ws, "playwright.config.ts");
		expect(info.testIdAttribute).toBeUndefined();
		expect(info.configSource).toBe("explicit");
		expect(info.notes.map((diagnostic) => diagnostic.code)).not.toContain(
			"testid-attribute-sibling",
		);
	});

	// `testIdAttribute: process.env.X` is positive evidence about this config, so
	// there is nothing for a neighbour to add.
	it("says nothing about siblings when the chosen config is unresolvable", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts":
				"export default { use: { testIdAttribute: process.env.ATTR } };",
			"playwright.base.config.ts":
				'export default { use: { testIdAttribute: "data-tid" } };',
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBeUndefined();
		expect(info.notes.map((diagnostic) => diagnostic.code)).toContain(
			"testid-attribute-unresolved",
		);
		expect(info.notes.map((diagnostic) => diagnostic.code)).not.toContain(
			"testid-attribute-sibling",
		);
	});

	it("takes nothing else from a sibling either", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": "export default { retries: 1 };",
			"playwright.base.config.ts":
				'export default { testDir: "./sibling-specs", use: { testIdAttribute: "data-tid" } };',
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBeUndefined();
		expect(info.testDir).toBeUndefined();
	});
});

/**
 * `candidates` is a ranked, capped subset of what discovery found — not an
 * inventory of the repository's configs. Typing it as the complete list invited
 * a consumer to treat "not listed" as "does not exist".
 */
describe("the candidates list", () => {
	it("is empty for an explicitly named config, which suppresses discovery", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": "export default {};",
			"config/pw.ts": 'export default { use: { testIdAttribute: "data-x" } };',
		});
		const info = readPlaywrightConfig(ws, "config/pw.ts");
		expect(info.candidates).toEqual([]);
		expect(info.candidatesTruncated).toBeUndefined();
	});

	it("says when ranking dropped candidates to respect the cap", () => {
		const files: Record<string, string> = {
			"playwright.config.ts": "export default {};",
		};
		for (let index = 0; index < MAX_CONFIG_CANDIDATES; index += 1) {
			files[`pkg${index}/playwright.config.ts`] = "export default {};";
		}
		const info = readPlaywrightConfig(workspaceWithConfig(files));
		expect(info.candidates).toHaveLength(MAX_CONFIG_CANDIDATES);
		expect(info.candidatesTruncated).toBe(true);
	});

	it("carries no truncation flag when every candidate fits", () => {
		const info = readPlaywrightConfig(
			workspaceWithConfig({
				"playwright.config.ts": "export default {};",
				"e2e/playwright.config.ts": "export default {};",
			}),
		);
		expect(info.candidates).toHaveLength(2);
		expect(info.candidatesTruncated).toBeUndefined();
	});
});

describe("an explicitly named config", () => {
	it("is read instead of anything discovery would have chosen", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts":
				'export default { use: { testIdAttribute: "data-discovered" } };',
			"config/pw.ts":
				'export default { use: { testIdAttribute: "data-explicit" } };',
		});
		const info = readPlaywrightConfig(ws, "config/pw.ts");
		expect(info.configFile).toBe("config/pw.ts");
		expect(info.configSource).toBe("explicit");
		expect(info.testIdAttribute).toBe("data-explicit");
	});

	// Falling back to discovery here would answer with a different file's
	// attribute while the caller believes they pinned one.
	it("warns and reads nothing at all when it does not exist", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts":
				'export default { use: { testIdAttribute: "data-discovered" } };',
		});
		const info = readPlaywrightConfig(ws, "config/missing.ts");
		expect(info.configFile).toBeNull();
		expect(info.testIdAttribute).toBeUndefined();
		const note = info.notes.find(
			(diagnostic) => diagnostic.code === "playwright-config-not-found",
		);
		expect(note?.severity).toBe("warning");
		expect(note?.data?.explicit).toBe("config/missing.ts");
	});

	it("is honoured through the workspace option", () => {
		const ws = workspaceWithConfig(
			{
				"playwright.config.ts":
					'export default { use: { testIdAttribute: "data-discovered" } };',
				"config/pw.ts":
					'export default { use: { testIdAttribute: "data-explicit" } };',
			},
			{ playwrightConfig: "config/pw.ts" },
		);
		expect(ws.testIdAttribute()).toEqual({
			attribute: "data-explicit",
			source: "playwright-config",
		});
		expect(ws.playwright().configFile).toBe("config/pw.ts");
	});
});
