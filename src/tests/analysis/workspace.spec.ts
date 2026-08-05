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
