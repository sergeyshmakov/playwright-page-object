import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { WorkspacePool } from "../../analysis/workspace";
import {
	cleanupScratchRoots,
	scratchRepo,
	writeIn as write,
} from "./helpers/onDisk";

/**
 * What a tool call is allowed to keep from the last one.
 *
 * The mtime sweep keeps the *contents* of the file set current, and the server
 * tells every caller so: "results reflect the files on disk at the moment of the
 * call". The set itself is decided once, when the project is built — which
 * tsconfig supplied the compiler options, which directory the scan was rooted
 * at. Change one of those and every later call answers the right shape of
 * question about the wrong directory.
 *
 * Idle eviction is not the backstop it looks like. `touch()` restarts on every
 * acquire, so the timer measures silence, and an agent that edits a config and
 * immediately asks again is the opposite of silent.
 */

/** One per spec file, so nothing leaks between them. */
const pool = new WorkspacePool();

function scratch(files: Record<string, string>): string {
	return scratchRepo(files, { prefix: "ppo-fresh-" });
}

afterAll(() => {
	cleanupScratchRoots();
	pool.clear();
});

describe("what survives a config edit", () => {
	it("rebuilds the project when testDir moves", () => {
		const root = scratch({
			"playwright.config.ts": 'export default { testDir: "./a" };',
			"a/tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
			}),
			"b/tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
			}),
			"a/spec.ts": "export const a = 1;",
			"b/spec.ts": "export const b = 1;",
		});
		pool.clear();
		const first = pool.acquire({ projectRoot: root });
		expect(first.tsconfigPath).toContain(`a${path.sep}tsconfig.json`);

		write(root, "playwright.config.ts", 'export default { testDir: "./b" };');
		const second = pool.acquire({ projectRoot: root });
		expect(second).not.toBe(first);
		expect(second.tsconfigPath).toContain(`b${path.sep}tsconfig.json`);
	});

	it("rebuilds when the chosen tsconfig is edited in place", () => {
		// `include`, `exclude` and `paths` all decide the file set, and editing
		// them leaves the path identical — so the path alone is not the identity.
		const root = scratch({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
				include: ["src/**/*.ts"],
			}),
			"src/a.ts": "export const a = 1;",
		});
		pool.clear();
		const first = pool.acquire({ projectRoot: root });
		write(
			root,
			"tsconfig.json",
			JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
				include: ["src/**/*.ts", "extra/**/*.ts"],
			}),
		);
		expect(pool.acquire({ projectRoot: root })).not.toBe(first);
	});

	it("rebuilds when a tsconfig the located one extends is edited", () => {
		// A shared base is where a monorepo keeps `paths` and half its `include`,
		// so watching only the leaf left an edit to the base invisible - later
		// calls analysing files under compiler options that no longer exist.
		const root = scratch({
			"tsconfig.base.json": JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
			}),
			"tsconfig.json": JSON.stringify({
				extends: "./tsconfig.base.json",
				include: ["src/**/*.ts"],
			}),
			"src/a.ts": "export const a = 1;",
		});
		pool.clear();
		const first = pool.acquire({ projectRoot: root });
		write(
			root,
			"tsconfig.base.json",
			JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true, strict: true },
			}),
		);
		expect(pool.acquire({ projectRoot: root })).not.toBe(first);
	});

	it("notices an extends target that did not exist yet", () => {
		// The chain resolved `./base.json` by *existence*, so a target that was
		// not there yet became `base.json.json` — and the day the real file
		// appeared nothing was watching it. A config coming into existence changes
		// the effective options as much as an edit does.
		const root = scratch({
			"tsconfig.json": JSON.stringify({
				extends: "./base.json",
				include: ["src/**/*.ts"],
			}),
			"src/a.ts": "export const a = 1;",
		});
		pool.clear();
		const first = pool.acquire({ projectRoot: root });
		write(
			root,
			"base.json",
			JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
			}),
		);
		expect(pool.acquire({ projectRoot: root })).not.toBe(first);
	});

	it("rebuilds when a linked config package it extends is edited", () => {
		// A package specifier was skipped on the theory that `node_modules`
		// changes by install and the lockfile stat covers it. True for an
		// installed package; false for a linked workspace one, whose base config
		// is edited like any other source file and moves neither the leaf
		// tsconfig nor the lockfile.
		const root = scratch({
			"node_modules/@repo/tsconfig/base.json": JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
			}),
			"tsconfig.json": JSON.stringify({
				extends: "@repo/tsconfig/base.json",
				include: ["src/**/*.ts"],
			}),
			"src/a.ts": "export const a = 1;",
		});
		pool.clear();
		const first = pool.acquire({ projectRoot: root });
		write(
			root,
			"node_modules/@repo/tsconfig/base.json",
			JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true, strict: true },
			}),
		);
		expect(pool.acquire({ projectRoot: root })).not.toBe(first);
	});

	it("keeps the same project when an ordinary source file changes", () => {
		// The guard has to be stable, or every call pays for a rebuild. An
		// unstable comparison here costs ~2.3 s per tool call on a large repo.
		const root = scratch({
			"playwright.config.ts": 'export default { testDir: "./e2e" };',
			"tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
			}),
			"e2e/spec.ts": "export const a = 1;",
		});
		pool.clear();
		const first = pool.acquire({ projectRoot: root });
		write(root, "e2e/spec.ts", "export const a = 2;");
		const second = pool.acquire({ projectRoot: root });
		expect(second).toBe(first);
		// And repeatedly, with nothing changed at all.
		expect(pool.acquire({ projectRoot: root })).toBe(first);
		expect(pool.acquire({ projectRoot: root })).toBe(first);
	});

	it("keeps the same project when the config changes something unrelated", () => {
		const root = scratch({
			"playwright.config.ts":
				'export default { testDir: "./e2e", retries: 0 };',
			"tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
			}),
			"e2e/spec.ts": "export const a = 1;",
		});
		pool.clear();
		const first = pool.acquire({ projectRoot: root });
		write(
			root,
			"playwright.config.ts",
			'export default { testDir: "./e2e", retries: 3 };',
		);
		expect(pool.acquire({ projectRoot: root })).toBe(first);
	});
});

describe("what a fixed scope stops saying", () => {
	it("retires scope-dir-missing once the directory appears", () => {
		// The normalized include pattern is part of the cache key, so the same
		// workspace is reused once the directory exists — and the warning outlived
		// the condition, telling the caller nothing from that directory was in
		// scope while the rescan had already loaded its files.
		const root = scratch({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
			}),
			"src/a.ts": "export const a = 1;",
		});
		pool.clear();
		const first = pool.acquire({
			projectRoot: root,
			include: ["src", "e2e"],
		});
		expect(first.warnings.map((one) => one.code)).toContain(
			"scope-dir-missing",
		);

		write(root, "e2e/spec.ts", "export const b = 1;");
		const second = pool.acquire({
			projectRoot: root,
			include: ["src", "e2e"],
		});
		expect(second).toBe(first);
		expect(second.warnings.map((one) => one.code)).not.toContain(
			"scope-dir-missing",
		);
	});
});

describe("what a fixed config stops saying", () => {
	it("retires a config note once the config is fixed", () => {
		// The notes used to be merged into the sticky warning list, where
		// `dedupeDiagnostics` collapses repeats but never retires one: the warning
		// outlived the mistake, and `environmentHint` kept telling an agent to
		// restart a server that had already picked the fix up.
		const root = scratch({
			"playwright.config.ts":
				"export default { use: { testIdAttribute: process.env.ATTR } };",
			"src/a.ts": "export const a = 1;",
		});
		pool.clear();
		const first = pool.acquire({ projectRoot: root });
		expect(
			first.environmentWarnings().map((diagnostic) => diagnostic.code),
		).toContain("testid-attribute-unresolved");

		write(
			root,
			"playwright.config.ts",
			'export default { use: { testIdAttribute: "data-tid" } };',
		);
		const second = pool.acquire({ projectRoot: root });
		expect(second.testIdAttribute().attribute).toBe("data-tid");
		expect(
			second.environmentWarnings().map((diagnostic) => diagnostic.code),
		).not.toContain("testid-attribute-unresolved");
	});
});

describe("what the freshness stamps have to reach", () => {
	it("re-globs on the call after a scan root appears", () => {
		// The re-glob is throttled by `staleAfterMs`, and `scanDirsChanged` is what
		// defeats the throttle when the scan directories moved. A root that did not
		// exist at the baseline was skipped rather than remembered, so *appearing*
		// — the one change that matters most for a directory — was the one change
		// it could not see, and the files in it waited out the window.
		//
		// Scoped with `include` rather than a tsconfig on purpose: those roots come
		// from the patterns, so a directory that does not exist yet is still one of
		// them. TypeScript's `wildcardDirectories` only lists directories that are
		// there, which is a second reason the appearance went unnoticed.
		const root = scratch({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
			}),
			"src/a.ts": "export const a = 1;",
		});
		pool.clear();
		// A long window, so only a directory change can open the throttle - and
		// three acquires, because `lastGlobAt` starts at 0, so the first
		// `revalidate` re-globs whatever the window says. The throttle is only
		// closed from the second one on.
		const scope = {
			projectRoot: root,
			include: ["src", "e2e"],
			staleAfterMs: 600_000,
		};
		const first = pool.acquire(scope);
		expect(
			first.sourceFiles().map((one) => first.rel(one.getFilePath())),
		).toEqual(["src/a.ts"]);
		pool.acquire(scope);

		write(root, "e2e/spec.ts", "export const b = 1;");
		const second = pool.acquire(scope);
		expect(second).toBe(first);
		expect(
			second
				.sourceFiles()
				.map((one) => second.rel(one.getFilePath()))
				.sort(),
		).toEqual(["e2e/spec.ts", "src/a.ts"]);
	});

	it("watches the monorepo lockfile above a package root", () => {
		// npm, yarn and pnpm keep one lockfile at the repository root and none in
		// the packages, so a server rooted at `apps/web` — the normal way to run
		// this on a monorepo — stat'ed nothing an install ever touches. Resolver
		// caches filled before a relinking install then survived it, still calling
		// first-party source an external dependency.
		const outer = scratch({
			"package-lock.json": JSON.stringify({ lockfileVersion: 3 }),
			"apps/web/tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
			}),
			"apps/web/src/a.ts": "export const a = 1;",
		});
		const root = path.join(outer, "apps", "web");
		pool.clear();
		const ws = pool.acquire({ projectRoot: root });
		// An install bumps the epoch, which is what drops every resolver cache
		// filled before it. Nothing under `apps/web` changes here.
		const before = ws.currentEpoch;
		write(
			outer,
			"package-lock.json",
			JSON.stringify({ lockfileVersion: 3, updated: true }),
		);
		ws.revalidate();
		expect(ws.currentEpoch).toBeGreaterThan(before);
	});
});
