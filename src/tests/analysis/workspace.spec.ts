import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../../analysis/workspace";
import { makeWorkspace } from "./helpers/inMemory";

const roots: string[] = [];

function scratch(files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppo-ws-"));
	roots.push(root);
	for (const [relativePath, contents] of Object.entries(files)) {
		write(root, relativePath, contents);
	}
	return root;
}

function write(root: string, relativePath: string, contents: string): void {
	const absolute = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, contents, "utf8");
}

/** Workspace-relative posix paths of everything the workspace analyses. */
function rels(ws: Workspace): string[] {
	return ws.sourceFiles().map((file) => ws.rel(file.getFilePath()));
}

/** mtimeMs has coarse resolution on some filesystems; stamp it explicitly. */
function touch(root: string, relativePath: string, secondsAhead: number): void {
	const absolute = path.join(root, relativePath);
	const when = new Date(Date.now() + secondsAhead * 1000);
	fs.utimesSync(absolute, when, when);
}

beforeEach(() => {
	Workspace.reset();
});

afterEach(() => {
	Workspace.reset();
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("Workspace.acquire", () => {
	it("reuses the workspace for the same root", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const first = Workspace.acquire({ projectRoot: root });
		const second = Workspace.acquire({ projectRoot: root });
		expect(second).toBe(first);
		expect(Workspace.cacheSize).toBe(1);
	});

	it("keeps only the two most recent roots", () => {
		const a = scratch({ "src/a.ts": "export const a = 1;" });
		const b = scratch({ "src/b.ts": "export const b = 1;" });
		const c = scratch({ "src/c.ts": "export const c = 1;" });
		const first = Workspace.acquire({ projectRoot: a });
		Workspace.acquire({ projectRoot: b });
		Workspace.acquire({ projectRoot: c });
		expect(Workspace.cacheSize).toBe(2);
		expect(Workspace.acquire({ projectRoot: a })).not.toBe(first);
	});

	it("treats different include globs as different workspaces", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const first = Workspace.acquire({ projectRoot: root });
		const second = Workspace.acquire({
			projectRoot: root,
			include: ["src/**"],
		});
		expect(second).not.toBe(first);
	});

	it("does not let a cached workspace bypass a tighter maxFiles", () => {
		const root = scratch({
			"src/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 1;",
		});
		Workspace.acquire({ projectRoot: root });
		expect(() => Workspace.acquire({ projectRoot: root, maxFiles: 1 })).toThrow(
			/exceeds the 1 file limit/,
		);
	});

	it("treats different analysis options as different workspaces", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const first = Workspace.acquire({ projectRoot: root });
		expect(
			Workspace.acquire({ projectRoot: root, libraryModules: ["@acme/po"] }),
		).not.toBe(first);
		expect(
			Workspace.acquire({
				projectRoot: root,
				preferSyntacticResolution: false,
			}),
		).not.toBe(first);
	});
});

describe("Workspace.revalidate", () => {
	it("detects an edited file and refreshes it", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
		expect(ws.revalidate()).toEqual({ changed: [], added: [], removed: [] });

		write(root, "src/a.ts", "export const a = 2;");
		touch(root, "src/a.ts", 60);
		const result = ws.revalidate();
		expect(result.changed).toEqual(["src/a.ts"]);
		expect(ws.project.getSourceFileOrThrow("a.ts").getFullText()).toContain(
			"= 2",
		);
	});

	it("detects a new file", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
		write(root, "src/b.ts", "export const b = 1;");
		expect(ws.revalidate().added).toEqual(["src/b.ts"]);
	});

	it("detects a deleted file and drops it from the project", () => {
		const root = scratch({
			"src/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 1;",
		});
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
		fs.rmSync(path.join(root, "src/b.ts"));
		expect(ws.revalidate().removed).toEqual(["src/b.ts"]);
		expect(ws.sourceFiles().map((file) => ws.rel(file.getFilePath()))).toEqual([
			"src/a.ts",
		]);
	});

	/**
	 * The guarantee a long-lived MCP session rests on: the throttle window is
	 * measured from the last re-glob, and a freshly built workspace has never
	 * globbed, so the first `revalidate()` after `acquire()` always rescans no
	 * matter how little time has passed since the workspace was created.
	 */
	it("re-globs on the first revalidate however young the workspace is", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const ws = Workspace.acquire({ projectRoot: root });
		write(root, "src/b.ts", "export const b = 1;");
		expect(ws.revalidate().added).toEqual(["src/b.ts"]);
	});

	it("bumps the epoch only when something actually changed", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
		const before = ws.currentEpoch;
		ws.revalidate();
		expect(ws.currentEpoch).toBe(before);
		write(root, "src/a.ts", "export const a = 3;");
		touch(root, "src/a.ts", 60);
		ws.revalidate();
		expect(ws.currentEpoch).toBe(before + 1);
	});
});

describe("Workspace.revalidate scoping", () => {
	const scopedTsConfig = JSON.stringify({
		compilerOptions: { target: "ES2022", noEmit: true },
		include: ["e2e"],
	});

	it("never widens a tsconfig-scoped project past its include", () => {
		const root = scratch({
			"tsconfig.json": scopedTsConfig,
			"e2e/a.ts": "export const a = 1;",
			"scripts/stray.ts": "export const stray = 1;",
		});
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
		expect(rels(ws)).toEqual(["e2e/a.ts"]);

		const result = ws.revalidate();
		expect(result.added).toEqual([]);
		expect(rels(ws)).toEqual(["e2e/a.ts"]);
	});

	it("still picks up a new file inside the tsconfig scope", () => {
		const root = scratch({
			"tsconfig.json": scopedTsConfig,
			"e2e/a.ts": "export const a = 1;",
			"scripts/stray.ts": "export const stray = 1;",
		});
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
		write(root, "e2e/b.ts", "export const b = 1;");

		expect(ws.revalidate().added).toEqual(["e2e/b.ts"]);
		expect(rels(ws)).toEqual(["e2e/a.ts", "e2e/b.ts"]);
	});

	it("honours an explicit include over the tsconfig scope", () => {
		const root = scratch({
			"tsconfig.json": scopedTsConfig,
			"e2e/a.ts": "export const a = 1;",
			"scripts/stray.ts": "export const stray = 1;",
		});
		const ws = Workspace.acquire({
			projectRoot: root,
			include: ["scripts"],
			staleAfterMs: 0,
		});
		ws.revalidate();
		expect(rels(ws)).toEqual(["scripts/stray.ts"]);
	});

	// The `maxFiles` cap counts the narrowed scope, so the narrowed scope is what
	// may be parsed: loading the tsconfig's whole source set and filtering it
	// afterwards would pay the exact cost the cap exists to refuse.
	it("does not parse the tsconfig's sources outside a narrowed include", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
				include: ["e2e", "scripts"],
			}),
			"e2e/a.ts": "export const a = 1;",
			"scripts/one.ts": "export const one = 1;",
			"scripts/two.ts": "export const two = 1;",
		});
		const ws = Workspace.acquire({ projectRoot: root, include: ["e2e"] });
		const parsed = ws.project
			.getSourceFiles()
			.map((file) => ws.rel(file.getFilePath()));
		expect(parsed).toEqual(["e2e/a.ts"]);
		expect(rels(ws)).toEqual(["e2e/a.ts"]);
	});

	it("keeps the tsconfig's compiler options when the scope is narrowed", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true, jsx: "react-jsx" },
				include: ["e2e"],
			}),
			"e2e/a.tsx": "export const A = () => <div data-testid='x' />;",
		});
		const ws = Workspace.acquire({ projectRoot: root, include: ["e2e"] });
		expect(ws.project.getCompilerOptions().jsx).toBeDefined();
		expect(rels(ws)).toEqual(["e2e/a.tsx"]);
	});
});

describe("Workspace include normalization", () => {
	const tree = {
		"src/a.ts": "export const a = 1;",
		"src/nested/b.tsx": "export const B = () => null;",
		"other/c.ts": "export const c = 1;",
	};

	it("expands a bare directory into a recursive source glob", () => {
		const root = scratch(tree);
		const ws = Workspace.acquire({ projectRoot: root, include: ["src"] });
		expect(rels(ws)).toEqual(["src/a.ts", "src/nested/b.tsx"]);
	});

	// `--src-dir src` on a JavaScript React app has to see its components: the
	// expansion set is the default scan's set, `.jsx` included.
	it("expands a bare directory to every extension the default scan sweeps", () => {
		const root = scratch({
			"src/App.jsx": "export const App = () => null;",
			"src/util.mts": "export const m = 1;",
			"src/legacy.cts": "export const c = 1;",
			"src/notes.md": "# not source",
		});
		const ws = Workspace.acquire({ projectRoot: root, include: ["src"] });
		expect(rels(ws)).toEqual(["src/App.jsx", "src/legacy.cts", "src/util.mts"]);
	});

	it("expands a directory written with a trailing slash", () => {
		const root = scratch(tree);
		const ws = Workspace.acquire({ projectRoot: root, include: ["src/"] });
		expect(rels(ws)).toEqual(["src/a.ts", "src/nested/b.tsx"]);
	});

	it("expands a directory written with Windows separators", () => {
		const root = scratch(tree);
		const ws = Workspace.acquire({
			projectRoot: root,
			include: ["src\\nested"],
		});
		expect(rels(ws)).toEqual(["src/nested/b.tsx"]);
	});

	it("expands an absolute directory inside the root", () => {
		const root = scratch(tree);
		const ws = Workspace.acquire({
			projectRoot: root,
			include: [path.join(root, "src")],
		});
		expect(rels(ws)).toEqual(["src/a.ts", "src/nested/b.tsx"]);
	});

	it("expands `.` to the whole root", () => {
		const root = scratch(tree);
		const ws = Workspace.acquire({ projectRoot: root, include: ["."] });
		expect(rels(ws)).toEqual(["other/c.ts", "src/a.ts", "src/nested/b.tsx"]);
	});

	it("leaves a real glob untouched", () => {
		const root = scratch(tree);
		const ws = Workspace.acquire({ projectRoot: root, include: ["src/*.ts"] });
		expect(rels(ws)).toEqual(["src/a.ts"]);
	});

	it("leaves a single file path untouched", () => {
		const root = scratch(tree);
		const ws = Workspace.acquire({ projectRoot: root, include: ["src/a.ts"] });
		expect(rels(ws)).toEqual(["src/a.ts"]);
	});

	it("expands a bare directory in `exclude` too", () => {
		const root = scratch(tree);
		const ws = Workspace.acquire({ projectRoot: root, exclude: ["src"] });
		expect(rels(ws)).toEqual(["other/c.ts"]);
	});

	it("expands a directory whose name ends in a dot segment", () => {
		const root = scratch({
			"foo.config/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 1;",
		});
		const ws = Workspace.acquire({
			projectRoot: root,
			include: ["foo.config"],
		});
		expect(rels(ws)).toEqual(["foo.config/a.ts"]);
	});

	it("expands a dotfile-style directory", () => {
		const root = scratch({
			".config/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 1;",
		});
		const ws = Workspace.acquire({ projectRoot: root, include: [".config"] });
		expect(rels(ws)).toEqual([".config/a.ts"]);
	});

	it("excludes a dotted directory instead of matching nothing", () => {
		const root = scratch({
			"foo.config/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 1;",
		});
		const ws = Workspace.acquire({
			projectRoot: root,
			exclude: ["foo.config"],
		});
		expect(rels(ws)).toEqual(["src/b.ts"]);
	});

	it("still treats an existing file as one file", () => {
		const root = scratch({
			"src/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 1;",
		});
		const ws = Workspace.acquire({ projectRoot: root, include: ["src/a.ts"] });
		expect(rels(ws)).toEqual(["src/a.ts"]);
	});
});

describe("Workspace.memo", () => {
	it("reuses a value while its dependencies are unchanged", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
		let calls = 0;
		const compute = () => {
			calls += 1;
			return calls;
		};
		expect(ws.memo("k", ["src/a.ts"], compute)).toBe(1);
		expect(ws.memo("k", ["src/a.ts"], compute)).toBe(1);
		expect(calls).toBe(1);
	});

	it("recomputes after the dependency is edited", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
		let calls = 0;
		const compute = () => {
			calls += 1;
			return calls;
		};
		ws.memo("k", ["src/a.ts"], compute);
		write(root, "src/a.ts", "export const a = 9;");
		touch(root, "src/a.ts", 60);
		ws.revalidate();
		expect(ws.memo("k", ["src/a.ts"], compute)).toBe(2);
	});

	it("keeps an unrelated memo alive across an edit elsewhere", () => {
		const root = scratch({
			"src/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 1;",
		});
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
		let calls = 0;
		const compute = () => {
			calls += 1;
			return calls;
		};
		ws.memo("depends-on-b", ["src/b.ts"], compute);
		write(root, "src/a.ts", "export const a = 2;");
		touch(root, "src/a.ts", 60);
		ws.revalidate();
		ws.memo("depends-on-b", ["src/b.ts"], compute);
		expect(calls).toBe(1);
	});
});

describe("Workspace paths and attribute resolution", () => {
	it("emits posix paths relative to the root regardless of platform", () => {
		const ws = makeWorkspace({ "e2e/nested/A.ts": "export class A {}" });
		const [file] = ws.sourceFiles();
		expect(ws.rel(file.getFilePath())).toBe("e2e/nested/A.ts");
		expect(ws.loc(file.getClassOrThrow("A"))).toMatchObject({
			file: "e2e/nested/A.ts",
			line: 1,
		});
	});

	it("prefers an explicit attribute over the config and the default", () => {
		expect(makeWorkspace({}).testIdAttribute()).toEqual({
			attribute: "data-testid",
			source: "default",
		});
		expect(
			makeWorkspace({}, { attribute: "data-qa" }).testIdAttribute(),
		).toEqual({ attribute: "data-qa", source: "param" });
	});

	it("scans .jsx sources when the project has no tsconfig", () => {
		const root = scratch({
			"src/App.jsx": "export const App = () => null;",
			"src/a.ts": "export const a = 1;",
		});
		const ws = Workspace.acquire({ projectRoot: root });
		expect(ws.jsxFiles().map((file) => ws.rel(file.getFilePath()))).toEqual([
			"src/App.jsx",
		]);
	});

	it("separates .ts sources from .tsx sources", () => {
		const ws = makeWorkspace({
			"src/a.ts": "export const a = 1;",
			"src/B.tsx": "export const B = () => null;",
			"src/types.d.ts": "declare const x: number;",
		});
		expect(ws.tsFiles().map((file) => ws.rel(file.getFilePath()))).toEqual([
			"src/a.ts",
		]);
		expect(ws.jsxFiles().map((file) => ws.rel(file.getFilePath()))).toEqual([
			"src/B.tsx",
		]);
	});
});
