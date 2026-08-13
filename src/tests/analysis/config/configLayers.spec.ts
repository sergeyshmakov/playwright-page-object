import { afterAll, describe, expect, it } from "vitest";
import { MAX_CONFIG_CANDIDATES } from "../../../analysis/config/configDiscovery";
import { readPlaywrightConfig } from "../../../analysis/config/playwrightConfig";
import { discoverPageObjects } from "../../../analysis/page-objects/discover";
import {
	type Workspace,
	type WorkspaceOptions,
	WorkspacePool,
} from "../../../analysis/workspace";
import { exampleWorkspace } from "../helpers/example";
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
 * `defineConfig(base, overrides)` is a supported Playwright form: its own
 * implementation folds the arguments left to right, deep-merging `use`. Reading
 * only the first argument silently dropped every override written in the second.
 */
describe("defineConfig with several arguments", () => {
	it("lets a later argument override an earlier one", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": [
				'import { defineConfig } from "@playwright/test";',
				"const base = {",
				'  testDir: "./base-specs",',
				'  use: { testIdAttribute: "data-base" },',
				"};",
				"export default defineConfig(base, {",
				'  testDir: "./leaf-specs",',
				'  use: { testIdAttribute: "data-leaf" },',
				"});",
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testDir).toBe("leaf-specs");
		expect(info.testIdAttribute).toBe("data-leaf");
	});

	// Playwright merges the arguments' `use` objects key by key
	// (`{...result.use, ...config.use}`), so a second argument that writes other
	// `use` keys leaves the first argument's attribute in place.
	/**
	 * Two named exports from one module are two independent layers.
	 *
	 * The cycle guard keyed on the file's path, so resolving the first argument
	 * marked the module seen and the second was rejected as a cycle - discarding a
	 * layer that carries the attribute the whole analysis runs on. Every existing
	 * multi-argument test uses a *local* `const base`, which never reaches the
	 * import path at all, so this intersection was uncovered.
	 */
	it("reads two named exports imported from the same module", () => {
		const ws = workspaceWithConfig({
			"shared.ts": [
				'export const base = { testDir: "./base-specs", use: { testIdAttribute: "data-base" } };',
				'export const overrides = { testDir: "./leaf-specs", use: { testIdAttribute: "data-leaf" } };',
			].join("\n"),
			"playwright.config.ts": [
				'import { defineConfig } from "@playwright/test";',
				'import { base, overrides } from "./shared";',
				"export default defineConfig(base, overrides);",
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testDir).toBe("leaf-specs");
		expect(info.testIdAttribute).toBe("data-leaf");
		expect(info.notes.map((note) => note.code)).not.toContain(
			"config-merge-unresolved",
		);
	});

	/**
	 * The spread spelling of the same shape, which failed *silently*: the
	 * unfollowable-spread path marks lower layers occluded instead of warning, so
	 * the base's own attribute was downgraded to unresolved rather than reported.
	 */
	it("reads two named exports spread from the same module", () => {
		const ws = workspaceWithConfig({
			"shared.ts": [
				'export const base = { use: { testIdAttribute: "data-base" } };',
				'export const overrides = { use: { testIdAttribute: "data-leaf" } };',
			].join("\n"),
			"playwright.config.ts": [
				'import { defineConfig } from "@playwright/test";',
				'import { base, overrides } from "./shared";',
				"export default defineConfig({ ...base, ...overrides });",
			].join("\n"),
		});
		expect(readPlaywrightConfig(ws).testIdAttribute).toBe("data-leaf");
	});

	/**
	 * The same export twice. A visited-set never pops, so the second occurrence
	 * was a cycle; a path-scoped set reads it both times, which is what JavaScript
	 * does.
	 */
	it("reads the same imported export used as two arguments", () => {
		const ws = workspaceWithConfig({
			"shared.ts":
				'export const base = { use: { testIdAttribute: "data-base" } };',
			"playwright.config.ts": [
				'import { defineConfig } from "@playwright/test";',
				'import { base } from "./shared";',
				"export default defineConfig(base, base);",
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBe("data-base");
		// The value cannot discriminate here - both occurrences are the same
		// export, so the answer is `data-base` either way. The warning can: a
		// visited-set called the second one a cycle and said so.
		expect(info.notes.map((note) => note.code)).not.toContain(
			"config-merge-unresolved",
		);
	});

	/**
	 * A missing export must not poison the module. The `seen` mark used to be set
	 * before the export was resolved, so a typo'd name made every *other* export
	 * of that file unreachable for the rest of the read.
	 */
	it("still reads a real export after a missing one from the same module", () => {
		const ws = workspaceWithConfig({
			"shared.ts":
				'export const real = { use: { testIdAttribute: "data-real" } };',
			"playwright.config.ts": [
				'import { defineConfig } from "@playwright/test";',
				'import { missing, real } from "./shared";',
				"export default defineConfig(missing, real);",
			].join("\n"),
		});
		expect(readPlaywrightConfig(ws).testIdAttribute).toBe("data-real");
	});

	it("deep-merges `use` across arguments the way Playwright does", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": [
				'import { defineConfig } from "@playwright/test";',
				'const base = { use: { testIdAttribute: "data-base" } };',
				'export default defineConfig(base, { use: { baseURL: "http://x" } });',
			].join("\n"),
		});
		expect(readPlaywrightConfig(ws).testIdAttribute).toBe("data-base");
	});
});

/**
 * The nested `use` object is a config object too.
 *
 * It can spread another one, and JavaScript resolves that spread exactly where
 * it is written — so the same layer splitting the top-level literal gets is the
 * only way to read it. A direct property lookup answered `"data-leaf"` for
 * `use: { testIdAttribute: "data-leaf", ...baseUse }`, confidently, and wrongly.
 */
describe("spreads inside the use object", () => {
	it("gives a trailing spread inside `use` the last word", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": [
				'const baseUse = { testIdAttribute: "data-shared" };',
				'export default { use: { testIdAttribute: "data-leaf", ...baseUse } };',
			].join("\n"),
		});
		expect(readPlaywrightConfig(ws).testIdAttribute).toBe("data-shared");
	});

	it("still lets the literal win when the spread comes first", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": [
				'const baseUse = { testIdAttribute: "data-shared" };',
				'export default { use: { ...baseUse, testIdAttribute: "data-leaf" } };',
			].join("\n"),
		});
		expect(readPlaywrightConfig(ws).testIdAttribute).toBe("data-leaf");
	});

	it("refuses to answer when a spread above the key cannot be followed", () => {
		const ws = workspaceWithConfig({
			"playwright.config.ts": [
				'import { defineConfig, devices } from "@playwright/test";',
				"export default defineConfig({",
				'  use: { testIdAttribute: "data-leaf", ...devices["Desktop Chrome"] },',
				"});",
			].join("\n"),
		});
		const info = readPlaywrightConfig(ws);
		expect(info.testIdAttribute).toBeUndefined();
		const note = info.notes.find(
			(diagnostic) => diagnostic.code === "testid-attribute-unresolved",
		);
		expect(note?.message).toContain("could not follow");
	});

	// A plain spread copies keys one level deep, so a `use` written next to it
	// replaces the spread's `use` entirely rather than merging into it.
	it("lets an own `use` replace the one a spread contributed", () => {
		const ws = workspaceWithConfig({
			"playwright/base.ts":
				'export default { use: { testIdAttribute: "data-base" } };',
			"playwright.config.ts": [
				'import base from "./playwright/base";',
				'export default { ...base, use: { baseURL: "http://x" } };',
			].join("\n"),
		});
		expect(readPlaywrightConfig(ws).testIdAttribute).toBeUndefined();
	});
});
