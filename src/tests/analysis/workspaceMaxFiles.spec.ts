import * as fs from "node:fs";
import * as path from "node:path";
import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalysisLimitError } from "../../analysis/diagnostics";
import { toPosix } from "../../analysis/util/paths";
import { resolveRelativeModule } from "../../analysis/util/resolve";
import { Workspace } from "../../analysis/workspace";
import { writeIn as write } from "./helpers/onDisk";
import {
	cleanupWorkspaces,
	clearPool,
	pool,
	recordingReads,
	rels,
	scratch,
} from "./helpers/workspaceScratch";

beforeEach(clearPool);
afterEach(cleanupWorkspaces);

describe("Workspace maxFiles enforcement", () => {
	const capped = {
		"tsconfig.json": JSON.stringify({
			compilerOptions: { target: "ES2022", noEmit: true },
			include: ["src"],
		}),
		"src/a.ts":
			'import { helper } from "../shared/helper.js";\nexport const a = helper;',
		"src/b.ts": "export const b = 1;",
		"shared/helper.js": "export const helper = 1;",
	};

	function parsed(ws: Workspace): string[] {
		return ws.project
			.getSourceFiles()
			.map((file) => ws.rel(file.getFilePath()));
	}

	// The resolver adds files long after the constructor's cap check, so nothing
	// counted them: one tool call could pull the workspace over `--max-files` for
	// the rest of the session without ever reporting `max_files_exceeded`.
	it("refuses a resolver-added file that breaks the cap", () => {
		const root = scratch(capped);
		const ws = pool.acquire({ projectRoot: root, maxFiles: 2 });
		expect(() =>
			resolveRelativeModule(
				ws.project,
				ws.project.getSourceFileOrThrow("a.ts"),
				"../shared/helper.js",
			),
		).toThrow(AnalysisLimitError);
		// Rolled back: the project is exactly what it was before the add.
		expect(parsed(ws)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("still resolves an on-demand import that fits inside the cap", () => {
		const root = scratch(capped);
		const ws = pool.acquire({ projectRoot: root, maxFiles: 3 });
		expect(
			resolveRelativeModule(
				ws.project,
				ws.project.getSourceFileOrThrow("a.ts"),
				"../shared/helper.js",
			),
		).toBeDefined();
		expect(parsed(ws)).toContain("shared/helper.js");
	});

	it("cannot be bypassed by retrying a rescan that broke the cap", () => {
		const root = scratch({
			"src/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 1;",
		});
		const options = { projectRoot: root, maxFiles: 2, staleAfterMs: 0 };
		const ws = pool.acquire(options);
		write(root, "src/c.ts", "export const c = 1;");

		expect(() => ws.revalidate()).toThrow(AnalysisLimitError);
		// The retry must not find a cached workspace that quietly kept the file.
		expect(() => pool.acquire(options)).toThrow(AnalysisLimitError);
		expect(() => ws.revalidate()).toThrow(AnalysisLimitError);
		expect(parsed(ws)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("recovers once the extra files are gone", () => {
		const root = scratch({
			"src/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 1;",
		});
		const options = { projectRoot: root, maxFiles: 2, staleAfterMs: 0 };
		pool.acquire(options);
		write(root, "src/c.ts", "export const c = 1;");
		expect(() => pool.acquire(options)).toThrow(AnalysisLimitError);

		fs.rmSync(path.join(root, "src/c.ts"));
		expect(rels(pool.acquire(options))).toEqual(["src/a.ts", "src/b.ts"]);
	});

	/**
	 * `--src-dir` says which files are *analysed*, not how many the project may
	 * hold. Counting only the narrowed scope meant an in-scope file could import
	 * arbitrarily many siblings outside it — each one parsed, retained and paid
	 * for — while the cap it was walking past reported nothing.
	 */
	it("counts a resolver-added file from outside a narrowed scope", () => {
		const root = scratch({
			"src/a.ts":
				'import { helper } from "../shared/helper";\nexport const a = helper;',
			"src/b.ts": "export const b = 1;",
			"shared/helper.ts": "export const helper = 1;",
		});
		const ws = pool.acquire({
			projectRoot: root,
			include: ["src"],
			maxFiles: 2,
		});
		expect(rels(ws)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(() =>
			resolveRelativeModule(
				ws.project,
				ws.project.getSourceFileOrThrow("a.ts"),
				"../shared/helper",
			),
		).toThrow(AnalysisLimitError);
		expect(parsed(ws)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	/**
	 * The admission count is a running total now, not a fresh
	 * `getSourceFiles().length` per admitted file. A total that drifted low would
	 * be a cap that quietly stopped applying, so the one path that can move the
	 * file set behind its back — a revalidate — has to reset it.
	 */
	it("keeps enforcing the cap after a rescan changed the file set", () => {
		const root = scratch({
			"src/a.ts":
				'import { helper } from "../shared/helper";\nexport const a = helper;',
			"shared/helper.ts": "export const helper = 1;",
		});
		const ws = pool.acquire({
			projectRoot: root,
			include: ["src"],
			maxFiles: 2,
			staleAfterMs: 0,
		});
		// One in-scope file so far; the cap has room for exactly one more.
		expect(rels(ws)).toEqual(["src/a.ts"]);

		write(root, "src/b.ts", "export const b = 1;");
		ws.revalidate();
		expect(rels(ws)).toEqual(["src/a.ts", "src/b.ts"]);

		// The rescan filled the cap, and the on-demand load has to see that.
		expect(() =>
			resolveRelativeModule(
				ws.project,
				ws.project.getSourceFileOrThrow("a.ts"),
				"../shared/helper",
			),
		).toThrow(AnalysisLimitError);
		expect(parsed(ws)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	// Reading the config parses a file, and it used to reach the project without
	// passing the gate at all: a project sitting exactly on the cap then held one
	// more than the cap allows — plus its imported base, plus every sibling read.
	it("counts the Playwright config it reads", () => {
		const root = scratch({
			"src/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 1;",
			"e2e/playwright.config.ts":
				'export default { use: { testIdAttribute: "data-x" } };',
		});
		const ws = pool.acquire({
			projectRoot: root,
			include: ["src"],
			maxFiles: 2,
		});
		expect(() => ws.playwright()).toThrow(AnalysisLimitError);
		expect(parsed(ws)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	/**
	 * The pre-parse check exists to refuse an oversized source set *before* it is
	 * read. Counting only the analysed subset let a tsconfig whose sources sit
	 * outside the analysed root walk straight past it: every one of those files
	 * was read and parsed, and the cap then rejected the project it had just paid
	 * for. What the cap counts and what the pre-check counts have to be the same
	 * set.
	 */
	const outsideRootTsConfig = () => {
		const files: Record<string, string> = {
			"app/tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
				include: ["src/**/*.ts", "../lib/**/*.ts"],
			}),
			"app/src/main.ts": "export const main = 1;",
		};
		for (let index = 0; index < 6; index += 1) {
			files[`lib/f${index}.ts`] = `export const f${index} = ${index};\n`;
		}
		return scratch(files);
	};

	it("refuses an oversized tsconfig before parsing its sources", () => {
		const root = outsideRootTsConfig();
		const reads = recordingReads(() => {
			expect(() =>
				pool.acquire({
					projectRoot: path.join(root, "app"),
					maxFiles: 3,
				}),
			).toThrow(AnalysisLimitError);
		});

		expect(
			reads.filter((file) => file.startsWith(`${toPosix(root)}/lib/`)),
		).toEqual([]);
	});

	// The other half of the same rule: a narrowed project is built with
	// `skipAddingFilesFromTsConfig`, so the tsconfig's set is never parsed and
	// counting it here would refuse a scope that costs nothing.
	it("still admits a narrowed scope inside an oversized tsconfig", () => {
		const root = outsideRootTsConfig();
		const ws = pool.acquire({
			projectRoot: path.join(root, "app"),
			include: ["src"],
			maxFiles: 3,
		});
		expect(rels(ws)).toEqual(["src/main.ts"]);
	});

	/**
	 * `Workspace.fromProject` lets a second workspace wrap a project that already
	 * has an owner. The gate registry replaced the first owner's entry, so a later
	 * wrapper with a laxer cap became the only one enforced and the first
	 * workspace's callers kept a guarantee that had stopped holding.
	 */
	it("keeps every owner's cap when two workspaces share a project", () => {
		const root = scratch({
			"src/a.ts":
				'import { helper } from "./helper.js";\nexport const a = helper;',
			"src/helper.js": "export const helper = 1;",
		});
		const project = new Project({
			skipAddingFilesFromTsConfig: true,
			skipFileDependencyResolution: true,
		});
		project.addSourceFileAtPath(path.join(root, "src/a.ts"));
		Workspace.fromProject(project, { projectRoot: root, maxFiles: 1 });
		Workspace.fromProject(project, { projectRoot: root, maxFiles: 50 });

		expect(() =>
			resolveRelativeModule(
				project,
				project.getSourceFileOrThrow("a.ts"),
				"./helper.js",
			),
		).toThrow(AnalysisLimitError);
	});
});

/**
 * A file the resolver pulls in mid-call is not in the memoized file list, and
 * nothing else was going to invalidate it: the next sweep finds the mtime it
 * already recorded, reports no change and never bumps the epoch. The file then
 * stayed invisible to `sourceFiles()` for the rest of the session.
 */
