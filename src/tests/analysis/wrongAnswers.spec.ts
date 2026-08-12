import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readPlaywrightConfig } from "../../analysis/config/playwrightConfig";
import { locateTsConfig } from "../../analysis/config/tsconfig";
import { discoverPageObjects } from "../../analysis/page-objects/discover";
import { buildPageObjectTree } from "../../analysis/page-objects/tree";
import { WorkspacePool } from "../../analysis/workspace";
import { validateServerOptions } from "../../mcp/options";
import { libImport, makeWorkspace } from "./helpers/inMemory";
import { cleanupScratchRoots, scratchRepo } from "./helpers/onDisk";

/**
 * Questions the tools answered confidently and wrongly.
 *
 * These are not gaps in coverage — a gap is visible. Each of these produced a
 * definite answer of the right shape, so nothing downstream had any reason to
 * doubt it: an analysis run against the wrong attribute, a member that promises
 * an API the value does not have, a scope that selects nothing, a class that
 * reports no members because a loop counter ran out.
 */

/** One per spec file, so nothing leaks between them. */
const pool = new WorkspacePool();

function scratch(files: Record<string, string>): string {
	return scratchRepo(files, { prefix: "ppo-wrong-" });
}

afterAll(() => {
	cleanupScratchRoots();
	pool.clear();
});

describe("config read wrongly", () => {
	it("does not silently skip a shorthand testIdAttribute", () => {
		// The whole analysis runs against whatever attribute this resolves to, so
		// dropping the key meant every id in every report came from the wrong
		// attribute with nothing said about it.
		const root = scratch({
			"playwright.config.ts": [
				'import { defineConfig } from "@playwright/test";',
				'const testIdAttribute = "data-tid";',
				"export default defineConfig({ use: { testIdAttribute } });",
			].join("\n"),
		});
		pool.clear();
		const ws = pool.acquire({ projectRoot: root });
		const config = readPlaywrightConfig(ws);
		expect(config.testIdAttribute).toBeUndefined();
		expect(
			config.notes.some((note) => note.message.includes("testIdAttribute")),
		).toBe(true);
	});

	it("does not select an ancestor tsconfig when testDir escapes the root", () => {
		// The walk's only stop condition is reaching the project root, which a
		// testDir outside it never does — so it ran to the filesystem root and
		// could pick, then fully parse, an unrelated ancestor's config.
		const outer = scratch({
			"tsconfig.json": "{}",
			"repo/package.json": "{}",
			"sibling/e2e/.keep": "",
		});
		const projectRoot = path.join(outer, "repo");
		const located = locateTsConfig(projectRoot, undefined, "../sibling/e2e");
		expect(located.source).toBe("none");
		expect(located.path).toBeNull();
	});
});

describe("exports read wrongly", () => {
	it("sees a parenthesized default export", () => {
		// Two costs, and the second is the one a caller feels: the summary says
		// `isDefaultExport: false`, and resolving a file to "its default-exported
		// page object" then finds none and silently falls back to the first class
		// declared in it.
		const discovery = discoverPageObjects(
			makeWorkspace({
				"e2e/HomePage.ts": [
					libImport("RootPageObject", "RootSelector"),
					"@RootSelector()",
					"class Other extends RootPageObject {}",
					"@RootSelector()",
					"class HomePage extends RootPageObject {}",
					"export default (HomePage);",
				].join("\n"),
			}),
		);
		const home = discovery.pageObjects.find(
			(one) => one.className === "HomePage",
		);
		expect(home?.isDefaultExport).toBe(true);
		expect(home?.isExported).toBe(true);
	});

	it("sees a default export through `as`", () => {
		const discovery = discoverPageObjects(
			makeWorkspace({
				"e2e/HomePage.ts": [
					libImport("RootPageObject", "RootSelector"),
					"@RootSelector()",
					"class HomePage extends RootPageObject {}",
					"export default HomePage as never;",
				].join("\n"),
			}),
		);
		expect(
			discovery.pageObjects.find((one) => one.className === "HomePage")
				?.isDefaultExport,
		).toBe(true);
	});
});

describe("scope validated wrongly", () => {
	it("refuses a glob whose static base escapes the root", () => {
		const root = scratch({ "src/.keep": "" });
		const problems = validateServerOptions({
			projectRoot: root,
			srcDirs: ["../other/**/*.tsx"],
		});
		expect(problems.join("\n")).toContain("outside --project-root");
	});

	it("refuses a glob that climbs out after its first magic segment", () => {
		// The static base is `src`, which is inside the root, and the pattern
		// reaches well outside it. `..` is never useful in a scope pattern and its
		// only effect here is to escape.
		const root = scratch({ "src/.keep": "" });
		const problems = validateServerOptions({
			projectRoot: root,
			srcDirs: ["src/**/../../../other/*.tsx"],
		});
		expect(problems.join("\n")).toContain("..");
	});

	it("refuses a `..` hidden inside a brace alternative", () => {
		// `src/{components,../..}/**` splits into `{components,..` and `..}`, and
		// neither is equal to `..` — so a segment check on `/` alone was one brace
		// away from being decorative.
		const root = scratch({ "src/.keep": "" });
		const problems = validateServerOptions({
			projectRoot: root,
			srcDirs: ["src/{components,../..}/**/*.tsx"],
		});
		expect(problems.join("\n")).toContain("..");
	});

	it("still accepts a glob inside the root", () => {
		const root = scratch({ "src/.keep": "" });
		expect(
			validateServerOptions({ projectRoot: root, srcDirs: ["src/**/*.tsx"] }),
		).toEqual([]);
	});

	it("still accepts a root-relative glob with no static base", () => {
		const root = scratch({ "src/.keep": "" });
		expect(
			validateServerOptions({ projectRoot: root, srcDirs: ["**/*.tsx"] }),
		).toEqual([]);
	});

	it("still accepts a negated pattern pointing outside", () => {
		// An exclusion of something outside the root is a harmless no-op, not a
		// mistake worth refusing.
		const root = scratch({ "src/.keep": "" });
		expect(
			validateServerOptions({ projectRoot: root, srcDirs: ["!../other/**"] }),
		).toEqual([]);
	});
});

describe("members typed wrongly", () => {
	function memberKind(
		files: Record<string, string>,
		member: string,
	): string | undefined {
		const tree = buildPageObjectTree(makeWorkspace(files), "HomePage");
		return tree.defs[tree.root]?.members.find((one) => one.name === member)
			?.result.kind;
	}

	it("reports `new Widget()` on a plain class as a locator", () => {
		// `getSelector` clones a PageObject instance and lets everything else fall
		// through as the raw Locator, so calling this a page object made apiHints
		// promise `.$` and the waits on a value that has neither.
		expect(
			memberKind(
				{
					"e2e/Widget.ts": "export class Widget { label = 1; }",
					"e2e/HomePage.ts": [
						libImport("RootPageObject", "RootSelector", "Selector"),
						'import { Widget } from "./Widget";',
						"@RootSelector()",
						"export class HomePage extends RootPageObject {",
						'  @Selector("Thing")',
						"  accessor Thing: Widget = new Widget();",
						"}",
					].join("\n"),
				},
				"Thing",
			),
		).toBe("locator");
	});

	it("still reports a real PageObject subclass as a page object", () => {
		expect(
			memberKind(
				{
					"e2e/Panel.ts": [
						libImport("PageObject"),
						"export class Panel extends PageObject {}",
					].join("\n"),
					"e2e/HomePage.ts": [
						libImport("RootPageObject", "RootSelector", "Selector"),
						'import { Panel } from "./Panel";',
						"@RootSelector()",
						"export class HomePage extends RootPageObject {",
						'  @Selector("Panel")',
						"  accessor Side: Panel = new Panel();",
						"}",
					].join("\n"),
				},
				"Side",
			),
		).toBe("pageObject");
	});

	it("still reports a subclass of a project page object as a page object", () => {
		// The guard has to survive a chain: the heritage walk resolves `Widget ->
		// BaseWidget -> PageObject`, so this must not be downgraded.
		expect(
			memberKind(
				{
					"e2e/BaseWidget.ts": [
						libImport("PageObject"),
						"export class BaseWidget extends PageObject {}",
					].join("\n"),
					"e2e/Widget.ts": [
						'import { BaseWidget } from "./BaseWidget";',
						"export class Widget extends BaseWidget {}",
					].join("\n"),
					"e2e/HomePage.ts": [
						libImport("RootPageObject", "RootSelector", "Selector"),
						'import { Widget } from "./Widget";',
						"@RootSelector()",
						"export class HomePage extends RootPageObject {",
						'  @Selector("Thing")',
						"  accessor Thing: Widget = new Widget();",
						"}",
					].join("\n"),
				},
				"Thing",
			),
		).toBe("pageObject");
	});

	it("reads every class a deep factory chain reaches", () => {
		// The D4 fixpoint used to stop after six rounds, and a class first reached
		// on the seventh shipped `members: []` - indistinguishable, in the payload,
		// from a class that genuinely has none.
		//
		// This nine-deep chain passed before the cap was removed too: D1/D2 register
		// every in-scope class with a library base up front, so all nine are read in
		// round one and the counter never advances. It is kept as the guard for the
		// chain itself, not as proof about the cap - the cap goes on the termination
		// argument in `discover.ts`, and no fixture here reaches round seven.
		const depth = 9;
		const files: Record<string, string> = {};
		for (let level = 0; level < depth; level += 1) {
			const next = level + 1 < depth ? `Level${level + 1}` : null;
			files[`e2e/Level${level}.ts`] = [
				libImport("PageObject", "Selector"),
				next ? `import { ${next} } from "./${next}";` : "",
				`export class Level${level} extends PageObject {`,
				`  @Selector("Id${level}")`,
				next
					? `  accessor Child = (locator: never) => new ${next}(locator);`
					: "  accessor Leaf!: never;",
				"}",
			].join("\n");
		}
		files["e2e/HomePage.ts"] = [
			libImport("RootPageObject", "RootSelector", "Selector"),
			'import { Level0 } from "./Level0";',
			"@RootSelector()",
			"export class HomePage extends RootPageObject {",
			'  @Selector("Root")',
			"  accessor Start = (locator: never) => new Level0(locator);",
			"}",
		].join("\n");

		const discovery = discoverPageObjects(makeWorkspace(files));
		for (let level = 0; level < depth; level += 1) {
			const summary = discovery.pageObjects.find(
				(one) => one.className === `Level${level}`,
			);
			expect(summary?.counts.members).toBeGreaterThan(0);
		}
	});
});
