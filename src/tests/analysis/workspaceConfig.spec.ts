import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_CONFIG_CANDIDATES } from "../../analysis/config/configDiscovery";
import { makeWorkspace } from "./helpers/inMemory";
import { writeIn as write } from "./helpers/onDisk";
import {
	cleanupWorkspaces,
	clearPool,
	pool,
	scratch,
	touch,
} from "./helpers/workspaceScratch";

beforeEach(clearPool);
afterEach(cleanupWorkspaces);

describe("Workspace config discovery caching", () => {
	it("keeps the candidate list across an epoch bump", () => {
		const root = scratch({
			"playwright.config.ts": "export default {};",
			"src/a.ts": "export const a = 1;",
		});
		const ws = pool.acquire({ projectRoot: root });
		const before = ws.configDiscovery();
		ws.bumpEpoch();
		expect(ws.configDiscovery()).toBe(before);
	});

	it("re-discovers once a config file appears", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
		expect(ws.playwright().configFile).toBeNull();

		write(
			root,
			"playwright.config.ts",
			'export default { use: { testIdAttribute: "data-late" } };',
		);
		ws.revalidate();

		expect(ws.configDiscovery().candidates).toHaveLength(1);
		expect(ws.testIdAttribute()).toEqual({
			attribute: "data-late",
			source: "playwright-config",
		});
	});

	/**
	 * The server's instructions promise that a Playwright config edit is visible
	 * to the next call, and a narrowed `--src-dir` is exactly where that promise
	 * looks doubtful: the config is not in the analysed scope, so nothing the
	 * scope predicate does can see it change.
	 *
	 * It holds because the mtime sweep walks the *project*, not the scope, and
	 * reading a config adds it to the project. Locked here so a future sweep that
	 * filters by scope — an obvious-looking optimisation — cannot silently start
	 * serving a stale attribute for the lifetime of a session.
	 */
	it("sees an edit to a config outside a narrowed scope", () => {
		const root = scratch({
			"src/a.ts": "export const a = 1;",
			"playwright.config.ts":
				'export default { use: { testIdAttribute: "data-first" } };',
		});
		const ws = pool.acquire({
			projectRoot: root,
			include: ["src"],
			staleAfterMs: 0,
		});
		expect(ws.testIdAttribute().attribute).toBe("data-first");
		expect(ws.sourceFiles().map((file) => ws.rel(file.getFilePath()))).toEqual([
			"src/a.ts",
		]);

		write(
			root,
			"playwright.config.ts",
			'export default { use: { testIdAttribute: "data-second" } };',
		);
		ws.revalidate();

		expect(ws.testIdAttribute()).toEqual({
			attribute: "data-second",
			source: "playwright-config",
		});
	});

	/**
	 * The config usually lives outside the analysed scope — always, for a
	 * tsconfig-backed or `--src-dir`-narrowed workspace. Such a file can never
	 * appear in the rescan's `added` list, so hanging invalidation off that list
	 * kept the stale candidate list for the lifetime of the process: adding a
	 * config to a running server did nothing until it was restarted.
	 */
	it("re-discovers a config created outside the analysed scope", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
				include: ["src"],
			}),
			"src/a.ts": "export const a = 1;",
		});
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
		expect(ws.playwright().configFile).toBeNull();

		write(
			root,
			"e2e/playwright.config.ts",
			'export default { use: { testIdAttribute: "data-late" } };',
		);
		expect(ws.revalidate().added, "outside the tsconfig's file set").toEqual(
			[],
		);

		expect(ws.playwright().configFile).toBe("e2e/playwright.config.ts");
		expect(ws.testIdAttribute()).toEqual({
			attribute: "data-late",
			source: "playwright-config",
		});
	});

	/**
	 * Whether the candidate list is *complete* is part of what the tools report,
	 * and a repository can cross that line without its first twenty candidates
	 * changing at all. Comparing only the list left `candidatesTruncated` saying
	 * "there are more" long after there were not.
	 */
	it("refreshes the truncation flag when only the tail changes", () => {
		const files: Record<string, string> = {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
				include: ["src"],
			}),
			"src/a.ts": "export const a = 1;",
		};
		// One past the cap, all outside the analysed scope so the mtime sweep can
		// never see the deletion and clear the list wholesale.
		const overflow = MAX_CONFIG_CANDIDATES + 1;
		for (let index = 0; index < overflow; index += 1) {
			const name = `configs/playwright.c${String(index).padStart(2, "0")}.config.ts`;
			files[name] = "export default {};";
		}
		const root = scratch(files);
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
		expect(ws.configDiscovery().candidates).toHaveLength(MAX_CONFIG_CANDIDATES);
		expect(ws.configDiscovery().truncated).toBe(true);

		// Ranking is lexicographic at equal depth, so the last name is the one the
		// cap was dropping: the kept twenty are identical either way.
		fs.rmSync(
			path.join(
				root,
				`configs/playwright.c${String(overflow - 1).padStart(2, "0")}.config.ts`,
			),
		);
		expect(ws.revalidate().removed, "outside the tsconfig's file set").toEqual(
			[],
		);

		expect(ws.configDiscovery().truncated).toBeUndefined();
	});

	it("notices a config that was deleted outside the analysed scope", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
				include: ["src"],
			}),
			"src/a.ts": "export const a = 1;",
			"e2e/playwright.config.ts":
				'export default { use: { testIdAttribute: "data-gone" } };',
		});
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
		expect(ws.testIdAttribute().attribute).toBe("data-gone");

		fs.rmSync(path.join(root, "e2e/playwright.config.ts"));
		ws.revalidate();

		expect(ws.playwright().configFile).toBeNull();
		expect(ws.testIdAttribute().attribute).toBe("data-testid");
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
		const ws = pool.acquire({ projectRoot: root });
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

describe("Workspace.memo", () => {
	it("reuses a value while its dependencies are unchanged", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
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
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
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
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
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
