import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_CONFIG_CANDIDATES } from "../../../analysis/config/configDiscovery";
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

	/**
	 * Playwright resolves relative config paths against `configDir` — the
	 * directory of the config file it *loaded* (`path.dirname(resolvedConfigFile)`
	 * in its own loader). A base config reached by import or spread contributes a
	 * bare string with no provenance attached, so where the literal was written
	 * has no bearing on what it means. Resolving against the defining layer's file
	 * pointed workspace construction at a directory Playwright never reads, and
	 * let it adopt whatever tsconfig happened to sit next to it.
	 */
	it("resolves an inherited testDir against the config Playwright loads", () => {
		const ws = workspaceWithConfig({
			"playwright/base.ts": 'export default { testDir: "./specs" };',
			"playwright.config.ts": [
				'import base from "./playwright/base";',
				"export default { ...base };",
			].join("\n"),
		});
		expect(readPlaywrightConfig(ws).testDir).toBe("specs");
	});

	it("resolves it against a nested entry config's own directory", () => {
		const ws = workspaceWithConfig({
			"shared/base.ts": 'export default { testDir: "./specs" };',
			"e2e/playwright.config.ts": [
				'import base from "../shared/base";',
				"export default { ...base };",
			].join("\n"),
		});
		expect(readPlaywrightConfig(ws).testDir).toBe("e2e/specs");
	});
});

/**
 * Spread precedence.
 *
 * `{ ...base, a: 1 }` and `{ a: 1, ...base }` are different objects, and the
 * second one is what a config writes when the base is meant to win. Treating
 * every spread as the lowest layer reported the losing value — with no note to
 * say the answer had been guessed at.
 */
describe("spread position", () => {
	it("lets a trailing spread override the literal's own properties", () => {
		const ws = workspaceWithConfig({
			"playwright/base.ts": [
				"export default {",
				'  testDir: "./base-specs",',
				'  use: { testIdAttribute: "data-base" },',
				"};",
			].join("\n"),
			"playwright.config.ts": [
				'import base from "./playwright/base";',
				"export default {",
				'  testDir: "./leaf-specs",',
				'  use: { testIdAttribute: "data-leaf" },',
				"  ...base,",
				"};",
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBe("data-base");
		expect(info.testIdAttributeFrom).toBe("base-config");
		expect(info.testDir).toBe("base-specs");
	});

	// The literal is split at the spread rather than hoisted around it: what is
	// written after the spread still wins, what is written before it still loses.
	it("splits the literal at the spread instead of hoisting it", () => {
		const ws = workspaceWithConfig({
			"playwright/base.ts": [
				"export default {",
				'  testDir: "./base-specs",',
				'  use: { testIdAttribute: "data-base" },',
				"};",
			].join("\n"),
			"playwright.config.ts": [
				'import base from "./playwright/base";',
				"export default {",
				'  use: { testIdAttribute: "data-early" },',
				"  ...base,",
				'  testDir: "./late",',
				"};",
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBe("data-base");
		expect(info.testDir).toBe("late");
	});

	it("keeps a leading spread below the literal's own properties", () => {
		const ws = workspaceWithConfig({
			"playwright/base.ts":
				'export default { use: { testIdAttribute: "data-base" } };',
			"playwright.config.ts": [
				'import base from "./playwright/base";',
				'export default { ...base, use: { testIdAttribute: "data-leaf" } };',
			].join("\n"),
		});
		expect(readPlaywrightConfig(ws).testIdAttribute).toBe("data-leaf");
	});
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
