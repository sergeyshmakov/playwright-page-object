import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	defaultExcludeGlobs,
	defaultIncludeGlobs,
	locateTsConfig,
	synthesizedCompilerOptions,
} from "../../../analysis/config/tsconfig";
import { AnalysisLimitError } from "../../../analysis/diagnostics";
import { Workspace } from "../../../analysis/workspace";

const roots: string[] = [];

function scratch(files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppo-tscfg-"));
	roots.push(root);
	for (const [relativePath, contents] of Object.entries(files)) {
		const absolute = path.join(root, relativePath);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, contents, "utf8");
	}
	return root;
}

afterAll(() => {
	for (const root of roots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
	Workspace.reset();
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
		expect(defaultExcludeGlobs("/repo")).toContain("!/repo/**/node_modules/**");
	});
});

describe("Workspace file discovery", () => {
	it("scans **/*.{ts,tsx} and warns when there is no tsconfig", () => {
		const root = scratch({
			"src/a.ts": "export const a = 1;",
			"src/b.tsx": "export const B = () => null;",
			"node_modules/pkg/index.ts": "export const x = 1;",
		});
		Workspace.reset();
		const ws = Workspace.acquire({ projectRoot: root });
		expect(ws.tsconfigPath).toBeNull();
		expect(ws.warnings.map((diagnostic) => diagnostic.code)).toContain(
			"no-tsconfig",
		);
		const files = ws.sourceFiles().map((file) => ws.rel(file.getFilePath()));
		expect(files.sort()).toEqual(["src/a.ts", "src/b.tsx"]);
	});

	it("loads files from a tsconfig when one exists", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({ include: ["src"] }),
			"src/a.ts": "export const a = 1;",
			"other/b.ts": "export const b = 1;",
		});
		Workspace.reset();
		const ws = Workspace.acquire({ projectRoot: root });
		expect(ws.tsconfigPath).toBe(path.join(root, "tsconfig.json"));
		expect(ws.sourceFiles().map((file) => ws.rel(file.getFilePath()))).toEqual([
			"src/a.ts",
		]);
	});

	it("refuses a workspace larger than maxFiles", () => {
		const files: Record<string, string> = {};
		for (let index = 0; index < 5; index += 1) {
			files[`src/f${index}.ts`] = `export const f${index} = ${index};`;
		}
		const root = scratch(files);
		Workspace.reset();
		expect(() => Workspace.acquire({ projectRoot: root, maxFiles: 2 })).toThrow(
			AnalysisLimitError,
		);
	});
});
