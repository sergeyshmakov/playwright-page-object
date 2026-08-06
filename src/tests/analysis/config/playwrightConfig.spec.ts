import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readPlaywrightConfig } from "../../../analysis/config/playwrightConfig";
import { discoverPageObjects } from "../../../analysis/page-objects/discover";
import { Workspace, type WorkspaceOptions } from "../../../analysis/workspace";
import { exampleWorkspace } from "../helpers/example";

const temporaryRoots: string[] = [];

/**
 * Playwright configs live outside the tsconfig `include` in practice, so they
 * have to be read straight off disk. That makes a real temp directory the
 * honest fixture here.
 */
function workspaceWithConfig(
	files: Record<string, string>,
	options: Partial<WorkspaceOptions> = {},
): Workspace {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppo-pwcfg-"));
	temporaryRoots.push(root);
	for (const [relativePath, contents] of Object.entries(files)) {
		const absolute = path.join(root, relativePath);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, contents, "utf8");
	}
	Workspace.reset();
	return Workspace.acquire({ projectRoot: root, ...options });
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
		expect(info.testDir).toBe("e2e");
		expect(info.testIdAttribute).toBe("data-qa");
		expect(info.notes).toEqual([]);
	});

	it("reads a bare object default export", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts":
				'export default { testDir: "./tests", use: { testIdAttribute: "qa-id" } };',
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testDir).toBe("tests");
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
		expect(info.testDir).toBe("e2e");
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
		expect(readPlaywrightConfig(ws, "config/pw.ts").testDir).toBe(
			"config/explicit",
		);
	});

	it("reads a CommonJS `module.exports = defineConfig(...)` config", () => {
		const ws = workspaceWithConfig({
			"playwright.config.js": [
				'const { defineConfig } = require("@playwright/test");',
				"module.exports = defineConfig({",
				'  testDir: "./e2e",',
				'  use: { testIdAttribute: "data-cjs" },',
				"});",
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.configFile).toBe("playwright.config.js");
		expect(info.testIdAttribute).toBe("data-cjs");
		expect(info.testDir).toBe("e2e");
		expect(info.notes).toEqual([]);
	});

	it("reads a bare `module.exports = { … }` config", () => {
		const ws = workspaceWithConfig({
			"playwright.config.cjs":
				'module.exports = { use: { testIdAttribute: "qa-cjs" } };',
		});
		expect(readPlaywrightConfig(ws).testIdAttribute).toBe("qa-cjs");
	});

	it("resolves a nested config's testDir against the config's own directory", () => {
		const ws = workspaceWithConfig({
			"e2e/playwright.config.ts": 'export default { testDir: "./specs" };',
		});
		expect(readPlaywrightConfig(ws).testDir).toBe("e2e/specs");
	});

	// An absent `testDir` means Playwright's own default — the config's directory.
	// A computed one means some other directory entirely. Reporting both as
	// `undefined` let workspace creation substitute the config's directory for a
	// value it had positive evidence was something else.
	it("separates a computed testDir from an omitted one", () => {
		const computed = workspaceWithConfig({
			"playwright.config.ts": [
				'import { defineConfig } from "@playwright/test";',
				"export default defineConfig({ testDir: process.env.E2E_DIR });",
			].join("\n"),
		});
		const info = readPlaywrightConfig(computed);
		expect(info.testDir).toBeUndefined();
		expect(info.testDirUnresolved).toBe(true);
		const note = info.notes.find(
			(diagnostic) => diagnostic.code === "testdir-unresolved",
		);
		expect(note?.severity).toBe("warning");
		expect(note?.loc).toMatchObject({ file: "playwright.config.ts", line: 2 });

		const omitted = readPlaywrightConfig(
			workspaceWithConfig({
				"playwright.config.ts": "export default { fullyParallel: true };",
			}),
		);
		expect(omitted.testDir).toBeUndefined();
		expect(omitted.testDirUnresolved).toBeUndefined();
		expect(omitted.notes).toEqual([]);
	});

	it("surfaces an unresolvable testIdAttribute as a workspace warning", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts":
				"export default { use: { testIdAttribute: process.env.ATTR } };",
		});
		expect(ws.testIdAttribute().attribute).toBe("data-testid");
		expect(ws.warnings.map((diagnostic) => diagnostic.code)).toContain(
			"testid-attribute-unresolved",
		);
	});

	/**
	 * An explicit `--attribute` short-circuits `testIdAttribute()` before it
	 * reaches the config, but the config is still the only source of
	 * `testdir-unresolved` and the shape diagnostics — and discovery's warnings
	 * are the only payload that carries them. The override decides the
	 * attribute, never whether the config is read.
	 */
	it("keeps config diagnostics when an explicit attribute overrides the config", () => {
		const ws = workspaceWithConfig(
			{
				"playwright.config.ts": [
					'import { defineConfig } from "@playwright/test";',
					"export default defineConfig({ testDir: process.env.E2E_DIR });",
				].join("\n"),
				"src/a.ts": "export const a = 1;",
			},
			{ attribute: "data-qa" },
		);
		expect(ws.testIdAttribute()).toEqual({
			attribute: "data-qa",
			source: "param",
		});
		expect(
			discoverPageObjects(ws).warnings.map((diagnostic) => diagnostic.code),
		).toContain("testdir-unresolved");
	});

	/**
	 * The inverse of what this used to assert. "No config found" was treated as
	 * not-news and dropped, which is exactly what let a repository whose config
	 * the old fixed-basename probe could not see look identical to a repository
	 * with no Playwright at all — while `data-testid` was quietly assumed.
	 */
	it("surfaces a missing config in the workspace warnings", () => {
		const ws = workspaceWithConfig({ "src/a.ts": "export const a = 1;" });
		ws.playwright();
		const note = ws.warnings.find(
			(diagnostic) => diagnostic.code === "playwright-config-not-found",
		);
		expect(note?.severity).toBe("info");
		expect(note?.message).toContain("data-testid");
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
		expect(info.configSource).toBe("none");
		expect(info.notes[0]).toMatchObject({
			code: "playwright-config-not-found",
			severity: "info",
		});
	});
});

/**
 * Repository-shape independence.
 *
 * The field failure this whole cluster exists for: a monorepo keeping its
 * config at `playwright/playwright.base.config.ts`. The old reader probed
 * `<root>` and `<root>/{test,tests,e2e}` for six fixed basenames, matched
 * nothing, and reported "no Playwright config" — so `use.testIdAttribute:
 * "data-tid"` was never read, `data-testid` was assumed, and all four tools
 * answered confidently about a repository they had mis-read.
 */
describe("config discovery", () => {
	it("finds a config in a directory nobody enumerated", () => {
		const ws = workspaceWithConfig({
			"playwright/playwright.base.config.ts": [
				'import { defineConfig } from "@playwright/test";',
				'export default defineConfig({ use: { testIdAttribute: "data-tid" } });',
			].join("\n"),
			"src/App.tsx": 'export const App = () => <div data-tid="Root" />;',
		});
		const info = readPlaywrightConfig(ws);
		expect(info.configFile).toBe("playwright/playwright.base.config.ts");
		expect(info.testIdAttribute).toBe("data-tid");
		expect(info.configSource).toBe("discovered");
		expect(ws.testIdAttribute()).toEqual({
			attribute: "data-tid",
			source: "playwright-config",
		});
	});

	it("finds a variant basename at the root", () => {
		const ws = workspaceWithConfig({
			"playwright-ct.config.ts":
				'export default { use: { testIdAttribute: "data-ct" } };',
		});
		expect(readPlaywrightConfig(ws).configFile).toBe("playwright-ct.config.ts");
	});

	it("reads the canonical name and lists the variant it passed over", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts":
				'export default { use: { testIdAttribute: "data-main" } };',
			"playwright.base.config.ts":
				'export default { use: { testIdAttribute: "data-base" } };',
		});
		const info = readPlaywrightConfig(ws);
		expect(info.configFile).toBe("playwright.config.ts");
		expect(info.testIdAttribute).toBe("data-main");
		expect(info.candidates).toEqual([
			"playwright.config.ts",
			"playwright.base.config.ts",
		]);
		const note = info.notes.find(
			(diagnostic) => diagnostic.code === "playwright-config-ambiguous",
		);
		expect(
			note?.severity,
			"an attribute was resolved, so this is a disclosure",
		).toBe("info");
		expect(note?.message).toContain("playwright.base.config.ts");
	});

	it("raises the ambiguity note to a warning when no attribute was found", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": 'export default { testDir: "./e2e" };',
			"packages/app/playwright.config.ts": "export default { retries: 1 };",
		});
		const note = readPlaywrightConfig(ws).notes.find(
			(diagnostic) => diagnostic.code === "playwright-config-ambiguous",
		);
		expect(note?.severity).toBe("warning");
	});

	it("prefers the nearer config and the .ts one", () => {
		expect(
			readPlaywrightConfig(
				workspaceWithConfig({
					"playwright.config.ts": "export default {};",
					"apps/web/playwright.config.ts": "export default {};",
				}),
			).configFile,
		).toBe("playwright.config.ts");

		expect(
			readPlaywrightConfig(
				workspaceWithConfig({
					"playwright.config.js": "module.exports = {};",
					"playwright.config.ts": "export default {};",
				}),
			).configFile,
		).toBe("playwright.config.ts");
	});

	// A config vendored into a dependency or copied into a build directory is
	// never the repository's own, and ranking it first would analyse the wrong
	// repository entirely.
	it("never looks inside node_modules or a build output directory", () => {
		const ws = workspaceWithConfig({
			"node_modules/pkg/playwright.config.ts":
				'export default { use: { testIdAttribute: "data-vendored" } };',
			"dist/playwright.config.ts":
				'export default { use: { testIdAttribute: "data-built" } };',
			"e2e/playwright.config.ts":
				'export default { use: { testIdAttribute: "data-mine" } };',
		});
		const info = readPlaywrightConfig(ws);
		expect(info.configFile).toBe("e2e/playwright.config.ts");
		expect(info.candidates).toEqual(["e2e/playwright.config.ts"]);
		expect(info.testIdAttribute).toBe("data-mine");
	});
});

/**
 * A config is routinely a merge. Reading only the file's own object literal
 * meant a leaf config that imports a shared base reported no attribute at all,
 * which downstream is indistinguishable from "the repository uses the default".
 */
describe("merged config layers", () => {
	it("reads the attribute out of an imported base config", () => {
		const ws = workspaceWithConfig({
			"playwright/base.ts": [
				'import { defineConfig } from "@playwright/test";',
				'export default defineConfig({ use: { testIdAttribute: "data-tid" } });',
			].join("\n"),
			"playwright.config.ts": [
				'import { defineConfig } from "@playwright/test";',
				'import base from "./playwright/base";',
				"export default defineConfig({ ...base, retries: 2 });",
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBe("data-tid");
		expect(info.testIdAttributeFrom).toBe("base-config");
		const note = info.notes.find(
			(diagnostic) => diagnostic.code === "testid-attribute-inherited",
		);
		expect(note?.data?.via).toBe("base-config");
		expect(note?.data?.from).toBe("playwright/base.ts");
	});

	it("lets the leaf config override the base it merges", () => {
		const ws = workspaceWithConfig({
			"playwright/base.ts":
				'export default { use: { testIdAttribute: "data-base" } };',
			"playwright.config.ts": [
				'import base from "./playwright/base";',
				'export default { ...base, use: { testIdAttribute: "data-leaf" } };',
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBe("data-leaf");
		expect(info.testIdAttributeFrom).toBe("primary");
		expect(
			info.notes.map((diagnostic) => diagnostic.code),
			"nothing was inherited, so nothing is disclosed",
		).not.toContain("testid-attribute-inherited");
	});

	it("reads a local object spread into the config literal", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": [
				'const shared = { use: { testIdAttribute: "data-shared" } };',
				"export default { ...shared, retries: 1 };",
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBe("data-shared");
		expect(info.testIdAttributeFrom).toBe("spread");
	});

	it("reads both arguments of an unknown merge helper", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": [
				'import { merge } from "ts-deepmerge";',
				'const base = { use: { testIdAttribute: "data-merged" } };',
				"export default merge(base, { retries: 3 });",
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBe("data-merged");
		expect(info.testIdAttributeFrom).toBe("merge-layer");
	});

	// The reader follows one import hop. Two is not a partial answer it may round
	// up: it has to say that a layer went unread.
	it("stops after one import hop and says so", () => {
		const ws = workspaceWithConfig({
			"deep.ts": 'export default { use: { testIdAttribute: "data-deep" } };',
			"mid.ts": [
				'import deep from "./deep";',
				"export default { ...deep };",
			].join("\n"),
			"playwright.config.ts": [
				'import mid from "./mid";',
				"export default { ...mid };",
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBeUndefined();
		expect(info.notes.map((diagnostic) => diagnostic.code)).toContain(
			"testid-attribute-maybe-spread",
		);
	});

	it("reports the layer it gave up on when the hop budget runs out", () => {
		const ws = workspaceWithConfig({
			"deep.ts": 'export default { use: { testIdAttribute: "data-deep" } };',
			"mid.ts": ['import deep from "./deep";', "export default deep;"].join(
				"\n",
			),
			"playwright.config.ts": [
				'import mid from "./mid";',
				"export default mid;",
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBeUndefined();
		expect(info.notes.map((diagnostic) => diagnostic.code)).toContain(
			"config-merge-unresolved",
		);
	});

	it("reports a merge argument it cannot read", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": [
				'import { merge } from "ts-deepmerge";',
				'import external from "@acme/playwright-preset";',
				'export default merge(external, { use: { testIdAttribute: "data-x" } });',
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBe("data-x");
		expect(info.notes.map((diagnostic) => diagnostic.code)).toContain(
			"config-merge-unresolved",
		);
	});

	it("terminates on an import cycle", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": [
				'import other from "./other";',
				"export default { ...other };",
			].join("\n"),
			"other.ts": [
				'import self from "./playwright.config";',
				"export default { ...self };",
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBeUndefined();
		expect(info.configFile).toBe("playwright.config.ts");
	});

	// Playwright resolves a relative `testDir` against the directory of the file
	// that wrote it, which with a merged base is not the file that was chosen.
	it("resolves a base config's testDir against the base config's directory", () => {
		const ws = workspaceWithConfig({
			"playwright/base.ts": 'export default { testDir: "./specs" };',
			"playwright.config.ts": [
				'import base from "./playwright/base";',
				"export default { ...base };",
			].join("\n"),
		});
		expect(readPlaywrightConfig(ws).testDir).toBe("playwright/specs");
	});
});

/**
 * The sibling probe.
 *
 * Splitting `use` into `playwright.base.config.ts` and pointing CI at
 * `playwright.config.ts` — with no import between them — is a real repository
 * shape. Reading only the chosen file reports `data-testid` on a codebase that
 * uses something else; reading the sibling silently would be a guess. So it is
 * read, used, and announced.
 */
describe("sibling config probe", () => {
	it("borrows an attribute from a sibling config and warns that it did", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": 'export default { testDir: "./e2e" };',
			"playwright.base.config.ts":
				'export default { use: { testIdAttribute: "data-tid" } };',
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBe("data-tid");
		expect(info.testIdAttributeFrom).toBe("sibling-config");
		const note = info.notes.find(
			(diagnostic) => diagnostic.code === "testid-attribute-inherited",
		);
		expect(note?.severity).toBe("warning");
		expect(note?.data?.via).toBe("sibling-config");
		expect(note?.data?.from).toBe("playwright.base.config.ts");
	});

	it("reports two siblings that disagree", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": 'export default { testDir: "./e2e" };',
			"playwright.a.config.ts":
				'export default { use: { testIdAttribute: "data-a" } };',
			"playwright.b.config.ts":
				'export default { use: { testIdAttribute: "data-b" } };',
		});
		const info = readPlaywrightConfig(ws);
		const note = info.notes.find(
			(diagnostic) => diagnostic.code === "testid-attribute-conflict",
		);
		expect(note).toBeDefined();
		expect(note?.data?.attribute).toBe(info.testIdAttribute);
		expect(note?.data?.other).not.toBe(info.testIdAttribute);
	});

	// A caller who names a config has answered the question the probe asks.
	it("does not probe siblings when the config was named explicitly", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": 'export default { testDir: "./e2e" };',
			"playwright.base.config.ts":
				'export default { use: { testIdAttribute: "data-tid" } };',
		});
		const info = readPlaywrightConfig(ws, "playwright.config.ts");
		expect(info.testIdAttribute).toBeUndefined();
		expect(info.configSource).toBe("explicit");
		expect(info.notes.map((diagnostic) => diagnostic.code)).not.toContain(
			"testid-attribute-inherited",
		);
	});

	// `testIdAttribute: process.env.X` is positive evidence that the value is not
	// the sibling's; papering over it with a neighbour's literal would report an
	// attribute the suite provably does not run with.
	it("does not paper over an unresolvable attribute with a sibling's", () => {
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
			"testid-attribute-inherited",
		);
	});

	it("contributes only the attribute, never the sibling's testDir", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": "export default { retries: 1 };",
			"playwright.base.config.ts":
				'export default { testDir: "./sibling-specs", use: { testIdAttribute: "data-tid" } };',
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBe("data-tid");
		expect(info.testDir).toBeUndefined();
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
