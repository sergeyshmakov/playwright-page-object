import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	defaultExcludeGlobs,
	defaultIncludeGlobs,
	locateTsConfig,
	SCAN_EXTENSIONS,
	SCAN_GLOB,
	synthesizedCompilerOptions,
	tsConfigChain,
	tsConfigFileNames,
} from "../../../analysis/config/tsconfig";
import { AnalysisLimitError } from "../../../analysis/diagnostics";
import { discoverPageObjects } from "../../../analysis/page-objects/discover";
import { WorkspacePool } from "../../../analysis/workspace";
import { cleanupScratchRoots, scratchRepo } from "../helpers/onDisk";

/** One per spec file, so nothing leaks between them. */
const pool = new WorkspacePool();

function scratch(files: Record<string, string>): string {
	return scratchRepo(files, { prefix: "ppo-tscfg-" });
}

afterAll(() => {
	cleanupScratchRoots();
	pool.clear();
});

describe("locateTsConfig", () => {
	it("prefers an explicit path", () => {
		const root = scratch({
			"tsconfig.json": "{}",
			"config/tsconfig.e2e.json": "{}",
		});
		const located = locateTsConfig(root, "config/tsconfig.e2e.json");
		expect(located.source).toBe("explicit");
		expect(located.path).toBe(path.join(root, "config/tsconfig.e2e.json"));
	});

	it("returns nothing when the explicit path does not exist", () => {
		const root = scratch({ "tsconfig.json": "{}" });
		expect(locateTsConfig(root, "nope.json")).toEqual({
			path: null,
			source: "none",
		});
	});

	it("falls back to the project root", () => {
		const root = scratch({ "tsconfig.json": "{}" });
		expect(locateTsConfig(root).source).toBe("project-root");
	});

	it("walks up from testDir when the root has none", () => {
		const root = scratch({ "e2e/tsconfig.json": "{}" });
		const located = locateTsConfig(root, undefined, "./e2e");
		expect(located.source).toBe("test-dir");
		expect(located.path).toBe(path.join(root, "e2e/tsconfig.json"));
	});

	it("walks up from a testDir nested far below the tsconfig", () => {
		const root = scratch({ "packages/app/e2e/tsconfig.json": "{}" });
		const located = locateTsConfig(
			root,
			undefined,
			"packages/app/e2e/tests/suites/smoke/specs",
		);
		expect(located.source).toBe("test-dir");
		expect(located.path).toBe(
			path.join(root, "packages/app/e2e/tsconfig.json"),
		);
	});

	it("stops at the project root instead of climbing out of it", () => {
		const outer = scratch({ "tsconfig.json": "{}" });
		const root = path.join(outer, "inner");
		fs.mkdirSync(path.join(root, "e2e"), { recursive: true });
		expect(locateTsConfig(root, undefined, "e2e")).toEqual({
			path: null,
			source: "none",
		});
	});

	it("reports `none` when nothing is found", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		expect(locateTsConfig(root)).toEqual({ path: null, source: "none" });
	});
});

describe("synthesised options", () => {
	it("parses TSX and emits nothing", () => {
		const options = synthesizedCompilerOptions();
		expect(options.noEmit).toBe(true);
		expect(options.jsx).toBeDefined();
	});

	it("builds absolute include and negated exclude globs", () => {
		const includes = defaultIncludeGlobs("/repo");
		expect(includes).toContain("/repo/**/*.tsx");
		expect(includes).toContain("/repo/**/*.jsx");
		expect(defaultExcludeGlobs("/repo")).toContain("!/repo/**/node_modules/**");
	});
});

describe("Workspace file discovery", () => {
	it("scans the default source globs and warns when there is no tsconfig", () => {
		const root = scratch({
			"src/a.ts": "export const a = 1;",
			"src/b.tsx": "export const B = () => null;",
			"node_modules/pkg/index.ts": "export const x = 1;",
		});
		pool.clear();
		const ws = pool.acquire({ projectRoot: root });
		expect(ws.tsconfigPath).toBeNull();
		expect(ws.warnings.map((diagnostic) => diagnostic.code)).toContain(
			"no-tsconfig",
		);
		const files = ws.sourceFiles().map((file) => ws.rel(file.getFilePath()));
		expect(files.sort()).toEqual(["src/a.ts", "src/b.tsx"]);
	});

	// The diagnostic is the only place a caller learns what was swept; naming a
	// narrower set than the scan really uses sends them hunting for files that
	// were in fact analysed.
	it("names the extensions it really scanned in the no-tsconfig warning", () => {
		const root = scratch({ "src/App.jsx": "export const App = () => null;" });
		pool.clear();
		const ws = pool.acquire({ projectRoot: root });
		const warning = ws.warnings.find(
			(diagnostic) => diagnostic.code === "no-tsconfig",
		);
		expect(warning?.message).toContain(SCAN_GLOB);
		for (const extension of SCAN_EXTENSIONS) {
			expect(warning?.message).toContain(extension);
		}
		expect(ws.sourceFiles()).toHaveLength(1);
	});

	it("loads files from a tsconfig when one exists", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({ include: ["src"] }),
			"src/a.ts": "export const a = 1;",
			"other/b.ts": "export const b = 1;",
		});
		pool.clear();
		const ws = pool.acquire({ projectRoot: root });
		expect(ws.tsconfigPath).toBe(path.join(root, "tsconfig.json"));
		expect(ws.sourceFiles().map((file) => ws.rel(file.getFilePath()))).toEqual([
			"src/a.ts",
		]);
	});

	// Playwright defaults `testDir` to the directory holding the config. Passing
	// `undefined` on to tsconfig discovery hid the e2e package's own tsconfig and
	// fell back to synthesized options plus a repo-wide scan, losing that
	// config's path aliases and include/exclude rules.
	it("uses a nested Playwright config's own directory when testDir is omitted", () => {
		const root = scratch({
			"e2e/playwright.config.ts":
				'export default { use: { testIdAttribute: "qa-id" } };',
			"e2e/tsconfig.json": JSON.stringify({
				compilerOptions: { baseUrl: "." },
				include: ["."],
			}),
			"e2e/Home.ts": "export const a = 1;",
			"src/ignored.ts": "export const b = 2;",
		});
		pool.clear();
		const ws = pool.acquire({ projectRoot: root });
		expect(ws.tsconfigPath).toBe(path.join(root, "e2e/tsconfig.json"));
		expect(
			ws.sourceFiles().map((file) => ws.rel(file.getFilePath())),
		).not.toContain("src/ignored.ts");
	});

	// That default only holds while the property is absent. A config that *does*
	// set `testDir`, to a value only the running process could produce, names a
	// directory that is specifically not the config's own — so substituting it
	// adopts a neighbouring tsconfig Playwright never reads and scopes the whole
	// analysis to sources it never runs, under compiler options it never uses.
	it("keeps the config's directory out of it when testDir is computed", () => {
		const root = scratch({
			"e2e/playwright.config.ts":
				"export default { testDir: process.env.E2E_DIR };",
			"e2e/tsconfig.json": JSON.stringify({
				compilerOptions: { baseUrl: "." },
				include: ["."],
			}),
			"e2e/Home.ts": "export const a = 1;",
			"src/app.ts": "export const b = 2;",
		});
		pool.clear();
		const ws = pool.acquire({ projectRoot: root });
		expect(ws.tsconfigPath).toBeNull();
		expect(
			ws.sourceFiles().map((file) => ws.rel(file.getFilePath())),
		).toContain("src/app.ts");
		// And the caller is told why the scope is what it is.
		expect(
			discoverPageObjects(ws).warnings.map((diagnostic) => diagnostic.code),
		).toContain("testdir-unresolved");
	});

	it("refuses a workspace larger than maxFiles", () => {
		const files: Record<string, string> = {};
		for (let index = 0; index < 5; index += 1) {
			files[`src/f${index}.ts`] = `export const f${index} = ${index};`;
		}
		const root = scratch(files);
		pool.clear();
		expect(() => pool.acquire({ projectRoot: root, maxFiles: 2 })).toThrow(
			AnalysisLimitError,
		);
	});
});

describe("tsConfigFileNames", () => {
	it("lists the tsconfig's sources without building a project", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({ include: ["src"] }),
			"src/a.ts": "export const a = 1;",
			"src/nested/b.ts": "export const b = 1;",
			"other/c.ts": "export const c = 1;",
		});
		const names = tsConfigFileNames(path.join(root, "tsconfig.json"));
		expect(names?.map((name) => path.basename(name)).sort()).toEqual([
			"a.ts",
			"b.ts",
		]);
	});

	it("returns null for a config it cannot read", () => {
		const root = scratch({});
		expect(tsConfigFileNames(path.join(root, "nope.json"))).toBeNull();
	});

	// TypeScript keeps a stale `files` entry in the parsed list and reports it as
	// an error; the project simply never loads it. Counting it would reject a
	// repository sitting exactly on the cap.
	it("drops a stale `files` entry the project would never load", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({ files: ["src/a.ts", "src/gone.ts"] }),
			"src/a.ts": "export const a = 1;",
		});
		expect(
			tsConfigFileNames(path.join(root, "tsconfig.json"))?.map((name) =>
				path.basename(name),
			),
		).toEqual(["a.ts"]);
	});

	it("keeps a repository at the cap analysable despite a stale `files` entry", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({ files: ["src/a.ts", "src/gone.ts"] }),
			"src/a.ts": "export const a = 1;",
		});
		pool.clear();
		const ws = pool.acquire({ projectRoot: root, maxFiles: 1 });
		expect(ws.sourceFiles().map((file) => ws.rel(file.getFilePath()))).toEqual([
			"src/a.ts",
		]);
	});
});

/**
 * The in-memory resolver tests set `paths` on the project by hand. This one
 * goes through a real tsconfig, where TypeScript — not the test — decides what
 * the mapping is relative to.
 */
describe("path aliases from a real tsconfig", () => {
	const sources = {
		"e2e/Ctrl.ts": [
			'import type { Locator } from "@playwright/test";',
			"export class Ctrl { constructor(private readonly _l: Locator) {} }",
		].join("\n"),
		"e2e/HomePage.ts": [
			'import type { Locator } from "@playwright/test";',
			'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
			'import { Ctrl } from "@/Ctrl";',
			'@RootSelector("Home")',
			"export class HomePage extends RootPageObject {",
			'  @Selector("promo", Ctrl)',
			"  accessor Promo!: Ctrl;",
			"}",
		].join("\n"),
	};

	function discoverWith(compilerOptions: Record<string, unknown>): string[] {
		const root = scratch({
			...sources,
			"tsconfig.json": JSON.stringify({ compilerOptions, include: ["e2e"] }),
		});
		pool.clear();
		const index = discoverPageObjects(pool.acquire({ projectRoot: root }), {
			includeControls: true,
		});
		return index.pageObjects.map((entry) => entry.id);
	}

	it("expands an aliased control when the config sets baseUrl", () => {
		expect(
			discoverWith({ baseUrl: ".", paths: { "@/*": ["e2e/*"] } }),
		).toContain("e2e/Ctrl.ts#Ctrl");
	});

	it("expands an aliased control when the config omits baseUrl", () => {
		expect(discoverWith({ paths: { "@/*": ["e2e/*"] } })).toContain(
			"e2e/Ctrl.ts#Ctrl",
		);
	});

	it("leaves a control external when nothing maps the specifier", () => {
		expect(discoverWith({})).not.toContain("e2e/Ctrl.ts#Ctrl");
	});
});

describe("maxFiles pre-scan", () => {
	it("rejects an oversized tsconfig before parsing its sources", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({ include: ["src"] }),
			"src/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 1;",
			"src/c.ts": "export const c = 1;",
		});
		pool.clear();
		expect(() => pool.acquire({ projectRoot: root, maxFiles: 2 })).toThrow(
			/3 source files, more than the configured limit of 2/,
		);
	});

	// The engine is consumed by the MCP server, by embedders and by tests; only
	// the MCP layer knows what its flags are called. An engine message naming
	// `maxFiles` / `include` sent every other caller looking for options that do
	// not exist on the surface they are holding.
	it("names no caller-specific option in the limit message", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({ include: ["src"] }),
			"src/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 1;",
		});
		pool.clear();
		let message = "";
		try {
			pool.acquire({ projectRoot: root, maxFiles: 1 });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("Narrow the analysed directories");
		expect(message).not.toMatch(/maxFiles|include|exclude/);
	});

	// The pre-scan counts a raw tsconfig file list, which includes declaration
	// files the loaded project never analyses. Counting those would reject a
	// repository that is comfortably inside the cap.
	it("ignores declaration files, exactly as sourceFiles() does", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({ include: ["src", "types"] }),
			"src/a.ts": "export const a = 1;",
			"types/globals.d.ts": "declare const x: number;",
			"types/other.d.ts": "declare const y: number;",
		});
		pool.clear();
		const ws = pool.acquire({ projectRoot: root, maxFiles: 1 });
		expect(ws.sourceFiles().map((file) => ws.rel(file.getFilePath()))).toEqual([
			"src/a.ts",
		]);
	});

	it("counts only what `include` scopes the analysis to", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({ include: ["src", "scripts"] }),
			"src/a.ts": "export const a = 1;",
			"scripts/one.ts": "export const one = 1;",
			"scripts/two.ts": "export const two = 1;",
		});
		pool.clear();
		const ws = pool.acquire({
			projectRoot: root,
			include: ["src"],
			maxFiles: 1,
		});
		expect(ws.sourceFiles().map((file) => ws.rel(file.getFilePath()))).toEqual([
			"src/a.ts",
		]);
	});
});

/**
 * The list of configs whose contents decide the located one's options. It is
 * the freshness fingerprint: anything missing from it is a file the server
 * keeps using stale options from, while promising every caller that "results
 * reflect the files on disk at the moment of the call".
 */
describe("tsConfigChain", () => {
	/** Basenames in the chain, so assertions do not care about the temp root. */
	function names(root: string): string[] {
		return tsConfigChain(path.join(root, "tsconfig.json")).map((one) =>
			path.relative(root, one).split(path.sep).join("/"),
		);
	}

	it("follows a deep extensionless chain to the end", () => {
		// Each extensionless hop has two legal spellings and both are watched, so
		// counting *enqueued paths* against the hop budget spent it twice per hop
		// and cut the chain at the halfway mark. The budget now counts configs
		// actually read.
		const files: Record<string, string> = {
			"tsconfig.json": JSON.stringify({ extends: "./a" }),
		};
		const letters = ["a", "b", "c", "d", "e"];
		letters.forEach((letter, index) => {
			const next = letters[index + 1];
			files[`${letter}.json`] = JSON.stringify(
				next
					? { extends: `./${next}` }
					: { compilerOptions: { target: "ES2022" } },
			);
		});
		const chain = names(scratch(files));
		for (const letter of letters) {
			expect(chain, `${letter}.json must be watched`).toContain(
				`${letter}.json`,
			);
		}
	});

	it("resolves a package config published through `exports`", () => {
		// A config package with no `tsconfig.json` at the path the layout guess
		// builds reads as "no base config at all", which is how a live server ends
		// up on compiler options that moved.
		const root = scratch({
			"node_modules/@repo/tsconfig/package.json": JSON.stringify({
				name: "@repo/tsconfig",
				exports: { ".": "./base.json" },
			}),
			"node_modules/@repo/tsconfig/base.json": JSON.stringify({
				compilerOptions: { target: "ES2022" },
			}),
			"tsconfig.json": JSON.stringify({ extends: "@repo/tsconfig" }),
		});
		expect(names(root)).toContain("node_modules/@repo/tsconfig/base.json");
	});

	it("falls back to the manifest `main` when there is no exports map", () => {
		const root = scratch({
			"node_modules/@repo/tsconfig/package.json": JSON.stringify({
				name: "@repo/tsconfig",
				main: "./configs/base.json",
			}),
			"node_modules/@repo/tsconfig/configs/base.json": JSON.stringify({
				compilerOptions: { target: "ES2022" },
			}),
			"tsconfig.json": JSON.stringify({ extends: "@repo/tsconfig" }),
		});
		expect(names(root)).toContain(
			"node_modules/@repo/tsconfig/configs/base.json",
		);
	});

	it("still watches a relative base that does not exist yet", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({ extends: "./base.json" }),
		});
		expect(names(root)).toContain("base.json");
	});

	it("terminates on a config that extends itself", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({ extends: "./tsconfig.json" }),
		});
		expect(names(root)).toEqual(["tsconfig.json"]);
	});
});
