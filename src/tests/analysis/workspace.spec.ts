import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CONFIG_CANDIDATES } from "../../analysis/config/configDiscovery";
import { AnalysisLimitError } from "../../analysis/diagnostics";
import { toPosix } from "../../analysis/util/paths";
import { resolveRelativeModule } from "../../analysis/util/resolve";
import { Workspace } from "../../analysis/workspace";
import { makeWorkspace } from "./helpers/inMemory";
import {
	cleanupScratchRoots,
	scratchRepo,
	writeIn as write,
} from "./helpers/onDisk";

/**
 * The `fs` ts-morph reads through.
 *
 * Its own `require("fs")` object, not this file's ESM namespace: the namespace
 * is frozen and cannot be spied on, while the CJS exports every dependency
 * shares can be swapped for the length of one call. It is the only way to see
 * *whether a file was parsed at all*, which is the whole difference between a
 * cap checked before the parse and one checked after it.
 */
const readingFs = createRequire(path.join(process.cwd(), "package.json"))(
	"node:fs",
) as typeof fs;

function scratch(files: Record<string, string>): string {
	return scratchRepo(files, { prefix: "ppo-ws-" });
}

/** Workspace-relative posix paths of everything the workspace analyses. */
function rels(ws: Workspace): string[] {
	return ws.sourceFiles().map((file) => ws.rel(file.getFilePath()));
}

/** Absolute posix paths every `readFileSync` saw while `body` ran. */
function recordingReads(body: () => void): string[] {
	const reads: string[] = [];
	const original = readingFs.readFileSync;
	(readingFs as { readFileSync: unknown }).readFileSync = (
		target: never,
		options: never,
	) => {
		reads.push(toPosix(String(target)));
		return original(target, options);
	};
	try {
		body();
	} finally {
		(readingFs as { readFileSync: unknown }).readFileSync = original;
	}
	return reads;
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
	cleanupScratchRoots();
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

	/**
	 * The LRU bounds how many workspaces are held, never how long. A stdio
	 * server is one process holding one workspace while the editor is open, so a
	 * ts-morph Project measured at 645 MB stayed resident all day whether or not
	 * another call ever came.
	 */
	it("drops a workspace nobody has asked anything for ten minutes", () => {
		vi.useFakeTimers();
		try {
			const root = scratch({ "src/a.ts": "export const a = 1;" });
			const first = Workspace.acquire({ projectRoot: root });
			expect(Workspace.cacheSize).toBe(1);

			vi.advanceTimersByTime(10 * 60_000 + 1);
			expect(Workspace.cacheSize, "idle for the whole window").toBe(0);

			// The next call answers; it simply pays to rebuild.
			const rebuilt = Workspace.acquire({ projectRoot: root });
			expect(rebuilt).not.toBe(first);
			expect(Workspace.cacheSize).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a workspace alive while calls keep arriving", () => {
		vi.useFakeTimers();
		try {
			const root = scratch({ "src/a.ts": "export const a = 1;" });
			const first = Workspace.acquire({ projectRoot: root });

			// Fifty-four minutes of work, nine minutes apart: never idle long enough.
			for (let call = 0; call < 6; call += 1) {
				vi.advanceTimersByTime(9 * 60_000);
				expect(Workspace.acquire({ projectRoot: root }), `call ${call}`).toBe(
					first,
				);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	/**
	 * The default refused every call on the repositories this server exists for —
	 * a 4,924-file application needed `--max-files` before anything worked — and
	 * because it is a startup flag, the agent holding that error cannot act on
	 * it. Raising it is the whole point; a test that only checked "some cap
	 * exists" would have let it be lowered again by accident.
	 */
	it("parses a repository of a few thousand files without a flag", () => {
		const files: Record<string, string> = {};
		for (let index = 0; index < 3_200; index += 1) {
			files[`src/m${index}.ts`] = `export const v${index} = ${index};`;
		}
		const root = scratch(files);

		const workspace = Workspace.acquire({ projectRoot: root });
		// Well past the old ceiling of 2,000, which refused this outright.
		expect(workspace.sourceFiles().length).toBeGreaterThanOrEqual(3_200);

		// And it says what that cost, because raising the ceiling removed the only
		// thing that ever mentioned the size of the scan.
		const note = workspace.warnings.find((one) => one.code === "large-scan");
		expect(note?.severity).toBe("info");
		expect(note?.data?.files).toBeGreaterThanOrEqual(3_200);
		expect(note?.message).toContain("--src-dir");
	}, 60_000);

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
			/more than the configured limit of 1/,
		);
	});

	/**
	 * `staleAfterMs` is a per-call freshness policy, not part of what the
	 * workspace *contains*, so it stays out of the cache key and the caller
	 * asking now decides how fresh the answer has to be. Keying on it instead
	 * would build a second project over the same files; ignoring it left a
	 * caller that asked for immediate rescans blind to new files for as long as
	 * the first caller's interval.
	 */
	it("applies the caller's staleAfterMs to a cached workspace", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const first = Workspace.acquire({
			projectRoot: root,
			staleAfterMs: 60_000,
		});
		// Spends the free first re-glob every freshly built workspace gets.
		Workspace.acquire({ projectRoot: root, staleAfterMs: 60_000 });
		// Nothing has changed on disk, so the long interval is what decides, and it
		// says do not walk the repository again.
		const quiet = Workspace.acquire({
			projectRoot: root,
			staleAfterMs: 60_000,
		});
		expect(quiet).toBe(first);
		expect(rels(quiet)).toEqual(["src/a.ts"]);

		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
		expect(ws).toBe(first);
		expect(rels(ws)).toEqual(["src/a.ts"]);
	});

	/**
	 * `staleAfterMs` throttles the *cost*, never the promise.
	 *
	 * The server tells every caller that results reflect the files on disk at the
	 * moment of the call, and a file the agent has just written is exactly what
	 * the mtime sweep cannot see — it only visits files the project already
	 * holds. So a changed directory defeats the interval, however long the caller
	 * set it: write a component, ask about it, see it.
	 */
	it("sees a new file inside the window when its directory changed", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const first = Workspace.acquire({
			projectRoot: root,
			staleAfterMs: 60_000,
		});
		Workspace.acquire({ projectRoot: root, staleAfterMs: 60_000 });
		write(root, "src/b.ts", "export const b = 1;");
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 60_000 });
		expect(ws).toBe(first);
		expect(rels(ws)).toEqual(["src/a.ts", "src/b.ts"]);
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

	// Which Playwright config is read decides the test-id attribute, which
	// decides every result. Reusing a workspace built against a different one
	// would answer the second caller with the first caller's attribute.
	it("treats a different playwrightConfig as a different workspace", () => {
		const root = scratch({
			"src/a.ts": "export const a = 1;",
			"one.config.ts": 'export default { use: { testIdAttribute: "one" } };',
			"two.config.ts": 'export default { use: { testIdAttribute: "two" } };',
		});
		const first = Workspace.acquire({
			projectRoot: root,
			playwrightConfig: "one.config.ts",
		});
		const second = Workspace.acquire({
			projectRoot: root,
			playwrightConfig: "two.config.ts",
		});
		expect(second).not.toBe(first);
		expect(first.testIdAttribute().attribute).toBe("one");
		expect(second.testIdAttribute().attribute).toBe("two");
	});
});

/**
 * A scope that selects nothing is a wrong answer wearing an empty one's
 * clothes: every tool succeeds, reports nothing, and gives no reason.
 */
describe("Workspace scope diagnostics", () => {
	it("warns when an analysed directory is not on disk", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const ws = Workspace.acquire({
			projectRoot: root,
			include: ["src", "packages/app"],
		});
		const warning = ws.warnings.find(
			(diagnostic) => diagnostic.code === "scope-dir-missing",
		);
		expect(warning?.data?.path).toBe("packages/app");
		expect(warning?.severity).toBe("warning");
	});

	it("still builds a usable workspace from the directories that do exist", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const ws = Workspace.acquire({
			projectRoot: root,
			include: ["src", "nope"],
		});
		expect(rels(ws)).toEqual(["src/a.ts"]);
	});

	// A glob is allowed to match nothing — that is indistinguishable from an
	// empty directory, and `scope-empty` covers the consequence from the
	// evidence side. Reporting it here would fire on every legitimate filter.
	it("says nothing about a glob that happens to match no file", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const ws = Workspace.acquire({
			projectRoot: root,
			include: ["src/**/*.tsx"],
		});
		expect(ws.warnings.map((diagnostic) => diagnostic.code)).not.toContain(
			"scope-dir-missing",
		);
	});

	/**
	 * An exclusion the scan does not carry is only a filter, and a filter runs
	 * after the parse it was meant to save. `--src-dir src --src-dir
	 * '!src/generated'` still read, parsed and retained every generated file, so
	 * a large one exhausted `--max-files` for a scope it was excluded from.
	 */
	it("never parses a directory a negated scope excluded", () => {
		const root = scratch({
			"src/a.ts": "export const a = 1;",
			"src/generated/x.ts": "export const x = 1;",
			"src/generated/y.ts": "export const y = 1;",
		});
		const ws = Workspace.acquire({
			projectRoot: root,
			include: ["src", "!src/generated"],
			// One in-scope file and a cap of one: the excluded pair can only fit if
			// it was never parsed.
			maxFiles: 1,
		});
		expect(rels(ws)).toEqual(["src/a.ts"]);
		expect(
			ws.project.getSourceFiles().map((file) => ws.rel(file.getFilePath())),
		).toEqual(["src/a.ts"]);
	});

	// The same, written the way the flag documents it: an exclusion on its own,
	// with no positive scope beside it. That takes the repository-wide scan
	// branch rather than the narrowed one, so it is a second place to forget.
	it("prunes an excluded directory from the repository-wide scan", () => {
		const root = scratch({
			"src/a.ts": "export const a = 1;",
			"src/generated/x.ts": "export const x = 1;",
			"src/generated/y.ts": "export const y = 1;",
		});
		const ws = Workspace.acquire({
			projectRoot: root,
			exclude: ["src/generated"],
			maxFiles: 1,
		});
		expect(
			ws.project.getSourceFiles().map((file) => ws.rel(file.getFilePath())),
		).toEqual(["src/a.ts"]);
	});

	// Same rule on the re-glob: a file created inside an excluded directory must
	// not be parsed the moment the sweep notices it either.
	it("keeps an excluded directory out of the rescan", () => {
		const root = scratch({
			"src/a.ts": "export const a = 1;",
			"src/generated/x.ts": "export const x = 1;",
		});
		const options = {
			projectRoot: root,
			include: ["src", "!src/generated"],
			staleAfterMs: 0,
		};
		const ws = Workspace.acquire(options);
		write(root, "src/generated/y.ts", "export const y = 1;");
		write(root, "src/b.ts", "export const b = 1;");
		ws.revalidate();

		expect(rels(ws)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(
			ws.project
				.getSourceFiles()
				.map((file) => ws.rel(file.getFilePath()))
				.filter((file) => file.startsWith("src/generated/")),
		).toEqual([]);
	});

	/**
	 * `[draft]` is a character class, so an exact path can be a glob without its
	 * author meaning one. Both engines that read the pattern — the scope
	 * predicate here and ts-morph's file adder — match an identical string before
	 * they compile anything, so the named file is selected either way. The
	 * failure this guards is one of them changing its mind: an adder that skipped
	 * the file, or a predicate that dropped what the adder brought in, is the
	 * silently-empty scope the shared engine exists to prevent.
	 */
	it("selects an exact scope path that contains glob metacharacters", () => {
		const root = scratch({
			"src/[draft].ts": "export const draft = 1;",
			"src/other.ts": "export const other = 1;",
		});
		const ws = Workspace.acquire({
			projectRoot: root,
			include: ["src/[draft].ts"],
		});
		expect(rels(ws)).toEqual(["src/[draft].ts"]);
	});

	it("says nothing about an excluded directory that is not there", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const ws = Workspace.acquire({ projectRoot: root, exclude: ["generated"] });
		expect(ws.warnings.map((diagnostic) => diagnostic.code)).not.toContain(
			"scope-dir-missing",
		);
	});

	it("reports an empty JSX scope through environmentWarnings", () => {
		const root = scratch({ "e2e/Page.ts": "export class Page {}" });
		const ws = Workspace.acquire({ projectRoot: root });
		expect(ws.environmentWarnings().map((one) => one.code)).toContain(
			"scope-empty",
		);
	});

	it("orders the attribute verdict ahead of the config notes", () => {
		const root = scratch({
			"src/App.tsx": [
				'export const App = () => <div data-tid="A"><b data-tid="B" /></div>;',
			].join("\n"),
		});
		const ws = Workspace.acquire({ projectRoot: root });
		const codes = ws.environmentWarnings().map((one) => one.code);
		expect(codes[0]).toBe("attribute-mismatch");
		expect(codes).toContain("playwright-config-not-found");
	});

	it("memoizes environmentWarnings per epoch and per attribute", () => {
		const root = scratch({ "src/App.tsx": "export const A = () => <b/>;" });
		const ws = Workspace.acquire({ projectRoot: root });
		const first = ws.environmentWarnings();
		expect(ws.environmentWarnings()).toBe(first);
		expect(ws.environmentWarnings("data-tid")).not.toBe(first);
		ws.bumpEpoch();
		expect(ws.environmentWarnings()).not.toBe(first);
	});
});

/**
 * One pattern, one engine.
 *
 * A scope pattern is read twice: once by ts-morph's `addSourceFilesAtPaths`,
 * which globs with picomatch through tinyglobby, and once by the scope
 * predicate that decides what `sourceFiles()` hands out. While the second was
 * hand-rolled the two disagreed about braces, character classes and extglobs —
 * the files were added to the project and then dropped from every answer, so
 * the analysis came back empty with nothing to say about why.
 */
describe("Workspace scope globs", () => {
	it("analyses the files a brace pattern selects", () => {
		const root = scratch({
			"src/a/b.tsx": "export const B = () => null;\n",
			"src/a/c.ts": "export const c = 1;\n",
			"src/a/d.md": "not source\n",
		});
		const ws = Workspace.acquire({
			projectRoot: root,
			include: ["**/{*.ts,*.tsx}"],
		});
		expect(rels(ws).sort()).toEqual(["src/a/b.tsx", "src/a/c.ts"]);
	});

	it("analyses the files an extglob selects", () => {
		const root = scratch({
			"src/components/A.tsx": "export const A = () => null;\n",
			"src/pages/B.tsx": "export const B = () => null;\n",
			"src/legacy/C.tsx": "export const C = () => null;\n",
		});
		const ws = Workspace.acquire({
			projectRoot: root,
			include: ["src/@(components|pages)/**"],
		});
		expect(rels(ws).sort()).toEqual([
			"src/components/A.tsx",
			"src/pages/B.tsx",
		]);
	});

	it("expands a directory whose name only looks like a glob", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;\n" });
		// `src/**` is a glob, so it is passed through rather than expanded — and a
		// trailing globstar covers the directory entry itself, which is what every
		// engine that will read this pattern next already believed.
		const ws = Workspace.acquire({ projectRoot: root, include: ["src/**"] });
		expect(rels(ws)).toEqual(["src/a.ts"]);
	});
});

/**
 * The config candidate list is the one cache an epoch bump does not clear: an
 * edit changes what a config *says*, never which files exist, and re-globbing
 * the repository on every keystroke would put a filesystem walk on the hot path.
 */
describe("Workspace config discovery caching", () => {
	it("keeps the candidate list across an epoch bump", () => {
		const root = scratch({
			"playwright.config.ts": "export default {};",
			"src/a.ts": "export const a = 1;",
		});
		const ws = Workspace.acquire({ projectRoot: root });
		const before = ws.configDiscovery();
		ws.bumpEpoch();
		expect(ws.configDiscovery()).toBe(before);
	});

	it("re-discovers once a config file appears", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
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
		const ws = Workspace.acquire({
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
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
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
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
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
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
		expect(ws.testIdAttribute().attribute).toBe("data-gone");

		fs.rmSync(path.join(root, "e2e/playwright.config.ts"));
		ws.revalidate();

		expect(ws.playwright().configFile).toBeNull();
		expect(ws.testIdAttribute().attribute).toBe("data-testid");
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
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
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
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
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
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
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
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
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

/**
 * One cap, one rule, wherever the file came from: the project never holds more
 * parsed source files than `maxFiles` — every file it retained, less
 * declaration files and ignored paths, and *not* filtered by the analysed
 * scope. Whatever addition breaks that is undone and reported, and the
 * condition is re-detected on every later call — a cap that could be walked
 * past by simply calling again is not a cap.
 */
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
		const ws = Workspace.acquire({ projectRoot: root, maxFiles: 2 });
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
		const ws = Workspace.acquire({ projectRoot: root, maxFiles: 3 });
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
		const ws = Workspace.acquire(options);
		write(root, "src/c.ts", "export const c = 1;");

		expect(() => ws.revalidate()).toThrow(AnalysisLimitError);
		// The retry must not find a cached workspace that quietly kept the file.
		expect(() => Workspace.acquire(options)).toThrow(AnalysisLimitError);
		expect(() => ws.revalidate()).toThrow(AnalysisLimitError);
		expect(parsed(ws)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("recovers once the extra files are gone", () => {
		const root = scratch({
			"src/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 1;",
		});
		const options = { projectRoot: root, maxFiles: 2, staleAfterMs: 0 };
		Workspace.acquire(options);
		write(root, "src/c.ts", "export const c = 1;");
		expect(() => Workspace.acquire(options)).toThrow(AnalysisLimitError);

		fs.rmSync(path.join(root, "src/c.ts"));
		expect(rels(Workspace.acquire(options))).toEqual(["src/a.ts", "src/b.ts"]);
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
		const ws = Workspace.acquire({
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
		const ws = Workspace.acquire({
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
		const ws = Workspace.acquire({
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
				Workspace.acquire({
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
		const ws = Workspace.acquire({
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
describe("Workspace on-demand additions", () => {
	it("shows a resolver-added file in the next sourceFiles()", () => {
		const root = scratch({
			"src/a.ts":
				'import { helper } from "./helper.js";\nexport const a = helper;',
			"src/helper.js": "export const helper = 1;",
		});
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
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
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
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
		const ws = Workspace.acquire({ projectRoot: root, include: ["src"] });
		expect(rels(ws)).toEqual(["src/a.ts"]);
		resolveRelativeModule(
			ws.project,
			ws.project.getSourceFileOrThrow("a.ts"),
			"../shared/helper",
		);
		expect(rels(ws)).toEqual(["src/a.ts"]);
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

/**
 * `--src-dir '!src/generated'` is documented as "everything except that
 * directory". Every consumer downstream matches include patterns literally, so
 * the `!` was read as the first character of a directory name: the pattern
 * matched nothing, the include list was nonempty, and the analysed scope came
 * out empty. Alongside a positive scope it was worse — the positive pattern
 * matched, and the exclusion the caller wrote was simply not applied.
 */
describe("Workspace negated scope", () => {
	const tree = {
		"src/a.ts": "export const a = 1;",
		"src/generated/b.ts": "export const b = 1;",
		"other/c.ts": "export const c = 1;",
	};

	it("scans everything but the negated directory", () => {
		const root = scratch(tree);
		const ws = Workspace.acquire({
			projectRoot: root,
			include: ["!src/generated"],
		});
		expect(rels(ws)).toEqual(["other/c.ts", "src/a.ts"]);
	});

	// Beside a positive scope the negation looked like it worked: the scan globs
	// go to ts-morph, which understands `!`. Everything downstream of the scan
	// did not — a file the resolver pulled in was matched against the include
	// list, where the positive pattern won and the exclusion was never read.
	it("applies a negation alongside a positive scope", () => {
		const root = scratch({
			"src/a.ts": 'import { b } from "./generated/b";\nexport const a = b;',
			"src/generated/b.ts": "export const b = 1;",
		});
		const ws = Workspace.acquire({
			projectRoot: root,
			include: ["src", "!src/generated"],
		});
		expect(rels(ws)).toEqual(["src/a.ts"]);

		resolveRelativeModule(
			ws.project,
			ws.project.getSourceFileOrThrow("a.ts"),
			"./generated/b",
		);
		expect(rels(ws), "an on-demand load is still out of scope").toEqual([
			"src/a.ts",
		]);
	});

	// A negated scope names nothing the analysis needs to find, so a directory
	// that is not there is not a misconfiguration to report.
	it("says nothing about a negated directory that is not there", () => {
		const root = scratch(tree);
		const ws = Workspace.acquire({
			projectRoot: root,
			include: ["src", "!src/nope"],
		});
		expect(ws.warnings.map((warning) => warning.code)).not.toContain(
			"scope-dir-missing",
		);
		expect(rels(ws)).toEqual(["src/a.ts", "src/generated/b.ts"]);
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
