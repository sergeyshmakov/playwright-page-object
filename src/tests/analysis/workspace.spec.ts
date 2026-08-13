import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalysisLimitError } from "../../analysis/diagnostics";
import { WorkspacePool } from "../../analysis/workspace";
import { writeIn as write } from "./helpers/onDisk";
import {
	cleanupWorkspaces,
	clearPool,
	pool,
	rels,
	scratch,
} from "./helpers/workspaceScratch";

beforeEach(clearPool);
afterEach(cleanupWorkspaces);

describe("WorkspacePool.acquire", () => {
	/**
	 * The reason the cache is an instance rather than a static: two servers in
	 * one process analyse two roots, and the in-memory transport every MCP test
	 * boots puts two of them side by side routinely.
	 */
	it("shares nothing with another pool", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const other = new WorkspacePool();
		const mine = pool.acquire({ projectRoot: root });
		expect(other.acquire({ projectRoot: root })).not.toBe(mine);
		expect(other.size).toBe(1);
		other.clear();
		expect(pool.size, "clearing one must not clear the other").toBe(1);
	});

	/**
	 * The workspace's own scan set outgrew its cap, so its scope is no longer
	 * viable and no sweep can make it so. Leaving it cached means the next call
	 * gets the rolled-back — that is, truncated — project and analyses it
	 * without complaint; dropping it makes the next `acquire` rebuild and refuse
	 * in `precheckMaxFiles`, before anything is parsed.
	 *
	 * This is the one line of coupling left from the workspace back to whatever
	 * holds it, and nothing exercised it before: with the eviction commented out
	 * the whole suite stayed green.
	 */
	it("drops a workspace whose own scan outgrew the cap", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
				include: ["src/**/*.ts"],
			}),
			"src/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 1;",
		});
		const held = pool.acquire({ projectRoot: root, maxFiles: 3 });
		expect(rels(held)).toHaveLength(2);
		expect(pool.size).toBe(1);

		write(root, "src/c.ts", "export const c = 1;");
		write(root, "src/d.ts", "export const d = 1;");
		expect(() =>
			pool.acquire({ projectRoot: root, maxFiles: 3, staleAfterMs: 0 }),
		).toThrow(AnalysisLimitError);
		expect(pool.size, "an unviable scope must not be handed out again").toBe(0);

		// And the rebuild refuses too, rather than quietly answering from the
		// truncated set the rollback left behind.
		expect(() => pool.acquire({ projectRoot: root, maxFiles: 3 })).toThrow(
			AnalysisLimitError,
		);
	});

	it("reuses the workspace for the same root", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const first = pool.acquire({ projectRoot: root });
		const second = pool.acquire({ projectRoot: root });
		expect(second).toBe(first);
		expect(pool.size).toBe(1);
	});

	it("keeps only the two most recent roots", () => {
		const a = scratch({ "src/a.ts": "export const a = 1;" });
		const b = scratch({ "src/b.ts": "export const b = 1;" });
		const c = scratch({ "src/c.ts": "export const c = 1;" });
		const first = pool.acquire({ projectRoot: a });
		pool.acquire({ projectRoot: b });
		pool.acquire({ projectRoot: c });
		expect(pool.size).toBe(2);
		expect(pool.acquire({ projectRoot: a })).not.toBe(first);
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
			const first = pool.acquire({ projectRoot: root });
			expect(pool.size).toBe(1);

			vi.advanceTimersByTime(10 * 60_000 + 1);
			expect(pool.size, "idle for the whole window").toBe(0);

			// The next call answers; it simply pays to rebuild.
			const rebuilt = pool.acquire({ projectRoot: root });
			expect(rebuilt).not.toBe(first);
			expect(pool.size).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a workspace alive while calls keep arriving", () => {
		vi.useFakeTimers();
		try {
			const root = scratch({ "src/a.ts": "export const a = 1;" });
			const first = pool.acquire({ projectRoot: root });

			// Fifty-four minutes of work, nine minutes apart: never idle long enough.
			for (let call = 0; call < 6; call += 1) {
				vi.advanceTimersByTime(9 * 60_000);
				expect(pool.acquire({ projectRoot: root }), `call ${call}`).toBe(first);
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

		const workspace = pool.acquire({ projectRoot: root });
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
		const first = pool.acquire({ projectRoot: root });
		const second = pool.acquire({
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
		pool.acquire({ projectRoot: root });
		expect(() => pool.acquire({ projectRoot: root, maxFiles: 1 })).toThrow(
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
		const first = pool.acquire({
			projectRoot: root,
			staleAfterMs: 60_000,
		});
		// Spends the free first re-glob every freshly built workspace gets.
		pool.acquire({ projectRoot: root, staleAfterMs: 60_000 });
		// Nothing has changed on disk, so the long interval is what decides, and it
		// says do not walk the repository again.
		const quiet = pool.acquire({
			projectRoot: root,
			staleAfterMs: 60_000,
		});
		expect(quiet).toBe(first);
		expect(rels(quiet)).toEqual(["src/a.ts"]);

		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
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
		const first = pool.acquire({
			projectRoot: root,
			staleAfterMs: 60_000,
		});
		pool.acquire({ projectRoot: root, staleAfterMs: 60_000 });
		write(root, "src/b.ts", "export const b = 1;");
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 60_000 });
		expect(ws).toBe(first);
		expect(rels(ws)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("treats different analysis options as different workspaces", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const first = pool.acquire({ projectRoot: root });
		expect(
			pool.acquire({ projectRoot: root, libraryModules: ["@acme/po"] }),
		).not.toBe(first);
		expect(
			pool.acquire({
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
		const first = pool.acquire({
			projectRoot: root,
			playwrightConfig: "one.config.ts",
		});
		const second = pool.acquire({
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
