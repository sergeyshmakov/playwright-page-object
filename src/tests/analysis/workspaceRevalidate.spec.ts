import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRelativeModule } from "../../analysis/util/resolve";
import { writeIn as write } from "./helpers/onDisk";
import {
	cleanupWorkspaces,
	clearPool,
	pool,
	rels,
	scratch,
	touch,
} from "./helpers/workspaceScratch";

beforeEach(clearPool);
afterEach(cleanupWorkspaces);

describe("Workspace.revalidate", () => {
	it("detects an edited file and refreshes it", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
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
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
		write(root, "src/b.ts", "export const b = 1;");
		expect(ws.revalidate().added).toEqual(["src/b.ts"]);
	});

	/**
	 * The tsconfig-backed rescan no longer goes through
	 * `addSourceFilesFromTsConfig` — it reads the config's file set itself and
	 * adds only the names the project does not already hold, which is half the
	 * work for the same answer. "The same answer" is this: a file created after
	 * startup still appears, and the call still reports it as added.
	 */
	it("detects a new file through a tsconfig-backed rescan", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ES2022" },
				include: ["src"],
			}),
			"src/a.ts": "export const a = 1;",
		});
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
		expect(ws.tsconfigPath).not.toBeNull();
		expect(rels(ws)).toEqual(["src/a.ts"]);

		write(root, "src/b.ts", "export const b = 1;");
		expect(ws.revalidate().added).toEqual(["src/b.ts"]);
		expect(rels(ws)).toEqual(["src/a.ts", "src/b.ts"]);

		// And a second sweep with nothing new reports nothing new — the rescan
		// must not read every already-loaded file back in as an addition.
		expect(ws.revalidate().added).toEqual([]);
	});

	it("honours the tsconfig's exclude on the rescan", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ES2022" },
				include: ["src"],
				exclude: ["src/generated"],
			}),
			"src/a.ts": "export const a = 1;",
		});
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
		write(root, "src/generated/x.ts", "export const x = 1;");
		write(root, "src/b.ts", "export const b = 1;");
		expect(ws.revalidate().added).toEqual(["src/b.ts"]);
		expect(rels(ws)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("detects a deleted file and drops it from the project", () => {
		const root = scratch({
			"src/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 1;",
		});
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
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
		const ws = pool.acquire({ projectRoot: root });
		write(root, "src/b.ts", "export const b = 1;");
		expect(ws.revalidate().added).toEqual(["src/b.ts"]);
	});

	/**
	 * A module the resolver pulls in on demand — a plain `.js` file, an alias
	 * target, anything outside the scan globs — joins the project long after
	 * `recordMtimes()` ran, so the first sweep that meets it has no stamp to
	 * compare against. Recording the new stamp and moving on froze that file's
	 * pre-edit AST for the rest of the session: every later sweep then found the
	 * mtime unchanged and never refreshed it.
	 */
	it("refreshes a file first seen after construction", () => {
		const root = scratch({
			"src/a.ts":
				'import { helper } from "./helper.js";\nexport const a = helper;',
			"src/helper.js": "export const helper = 1;",
		});
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
		// `.js` is outside SCAN_GLOB, so the file is in the project only because
		// the resolver added it while following the import.
		expect(rels(ws)).toEqual(["src/a.ts"]);
		const added = resolveRelativeModule(
			ws.project,
			ws.project.getSourceFileOrThrow("a.ts"),
			"./helper.js",
		);
		expect(added).toBeDefined();

		write(root, "src/helper.js", "export const helper = 2;");
		touch(root, "src/helper.js", 60);

		expect(ws.revalidate().changed).toContain("src/helper.js");
		expect(added?.getFullText()).toContain("= 2");
	});

	it("does not report an untouched first-seen file as changed", () => {
		const root = scratch({
			"src/a.ts":
				'import { helper } from "./helper.js";\nexport const a = helper;',
			"src/helper.js": "export const helper = 1;",
		});
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
		resolveRelativeModule(
			ws.project,
			ws.project.getSourceFileOrThrow("a.ts"),
			"./helper.js",
		);
		const before = ws.currentEpoch;
		expect(ws.revalidate()).toEqual({ changed: [], added: [], removed: [] });
		expect(ws.currentEpoch).toBe(before);
	});

	it("bumps the epoch only when something actually changed", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
		const before = ws.currentEpoch;
		ws.revalidate();
		expect(ws.currentEpoch).toBe(before);
		write(root, "src/a.ts", "export const a = 3;");
		touch(root, "src/a.ts", 60);
		ws.revalidate();
		expect(ws.currentEpoch).toBe(before + 1);
	});
});

/**
 * One cap, one rule, wherever the file came from: the project never holds more
 * parsed source files than `maxFiles` — every file it retained, less
 * declaration files and ignored paths, and *not* filtered by the analysed
 * scope. Whatever addition breaks that is undone and reported, and the
 * condition is re-detected on every later call — a cap that could be walked
 * past by simply calling again is not a cap.
 */

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
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
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
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
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
		const ws = pool.acquire({
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
		const ws = pool.acquire({ projectRoot: root, include: ["e2e"] });
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
		const ws = pool.acquire({ projectRoot: root, include: ["e2e"] });
		expect(ws.project.getCompilerOptions().jsx).toBeDefined();
		expect(rels(ws)).toEqual(["e2e/a.tsx"]);
	});
});

describe("Workspace on-demand additions", () => {
	it("shows a resolver-added file in the next sourceFiles()", () => {
		const root = scratch({
			"src/a.ts":
				'import { helper } from "./helper.js";\nexport const a = helper;',
			"src/helper.js": "export const helper = 1;",
		});
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
		// `.js` is outside the scan globs, so it is in the project only once the
		// resolver follows the import — and `rels` here memoizes the list first.
		expect(rels(ws)).toEqual(["src/a.ts"]);
		resolveRelativeModule(
			ws.project,
			ws.project.getSourceFileOrThrow("a.ts"),
			"./helper.js",
		);

		expect(rels(ws)).toEqual(["src/a.ts", "src/helper.js"]);
		ws.revalidate();
		expect(rels(ws)).toContain("src/helper.js");
	});

	// Only the file list is dropped. An epoch bump on every admission would throw
	// away the config read and every other per-epoch memo hundreds of times over
	// during a single walk.
	it("does not bump the epoch for an on-demand addition", () => {
		const root = scratch({
			"src/a.ts":
				'import { helper } from "./helper.js";\nexport const a = helper;',
			"src/helper.js": "export const helper = 1;",
		});
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
		const before = ws.currentEpoch;
		resolveRelativeModule(
			ws.project,
			ws.project.getSourceFileOrThrow("a.ts"),
			"./helper.js",
		);
		expect(ws.currentEpoch).toBe(before);
	});

	// A file outside the analysed scope still counts against the cap, but it has
	// no business appearing in the analysed set.
	it("leaves an out-of-scope addition out of the analysed set", () => {
		const root = scratch({
			"src/a.ts":
				'import { helper } from "../shared/helper";\nexport const a = helper;',
			"shared/helper.ts": "export const helper = 1;",
		});
		const ws = pool.acquire({ projectRoot: root, include: ["src"] });
		expect(rels(ws)).toEqual(["src/a.ts"]);
		resolveRelativeModule(
			ws.project,
			ws.project.getSourceFileOrThrow("a.ts"),
			"../shared/helper",
		);
		expect(rels(ws)).toEqual(["src/a.ts"]);
	});
});
