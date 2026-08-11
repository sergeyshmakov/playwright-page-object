import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Workspace } from "../../analysis/workspace";

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

const roots: string[] = [];

function scratch(files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppo-fresh-"));
	roots.push(root);
	for (const [relativePath, contents] of Object.entries(files)) {
		const absolute = path.join(root, relativePath);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, contents, "utf8");
	}
	return root;
}

function write(root: string, relativePath: string, contents: string): void {
	const absolute = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, contents, "utf8");
}

afterAll(() => {
	for (const root of roots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
	Workspace.reset();
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
		Workspace.reset();
		const first = Workspace.acquire({ projectRoot: root });
		expect(first.tsconfigPath).toContain(`a${path.sep}tsconfig.json`);

		write(root, "playwright.config.ts", 'export default { testDir: "./b" };');
		const second = Workspace.acquire({ projectRoot: root });
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
		Workspace.reset();
		const first = Workspace.acquire({ projectRoot: root });
		write(
			root,
			"tsconfig.json",
			JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
				include: ["src/**/*.ts", "extra/**/*.ts"],
			}),
		);
		expect(Workspace.acquire({ projectRoot: root })).not.toBe(first);
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
		Workspace.reset();
		const first = Workspace.acquire({ projectRoot: root });
		write(
			root,
			"tsconfig.base.json",
			JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true, strict: true },
			}),
		);
		expect(Workspace.acquire({ projectRoot: root })).not.toBe(first);
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
		Workspace.reset();
		const first = Workspace.acquire({ projectRoot: root });
		write(root, "e2e/spec.ts", "export const a = 2;");
		const second = Workspace.acquire({ projectRoot: root });
		expect(second).toBe(first);
		// And repeatedly, with nothing changed at all.
		expect(Workspace.acquire({ projectRoot: root })).toBe(first);
		expect(Workspace.acquire({ projectRoot: root })).toBe(first);
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
		Workspace.reset();
		const first = Workspace.acquire({ projectRoot: root });
		write(
			root,
			"playwright.config.ts",
			'export default { testDir: "./e2e", retries: 3 };',
		);
		expect(Workspace.acquire({ projectRoot: root })).toBe(first);
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
		Workspace.reset();
		const first = Workspace.acquire({
			projectRoot: root,
			include: ["src", "e2e"],
		});
		expect(first.warnings.map((one) => one.code)).toContain(
			"scope-dir-missing",
		);

		write(root, "e2e/spec.ts", "export const b = 1;");
		const second = Workspace.acquire({
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
		Workspace.reset();
		const first = Workspace.acquire({ projectRoot: root });
		expect(
			first.environmentWarnings().map((diagnostic) => diagnostic.code),
		).toContain("testid-attribute-unresolved");

		write(
			root,
			"playwright.config.ts",
			'export default { use: { testIdAttribute: "data-tid" } };',
		);
		const second = Workspace.acquire({ projectRoot: root });
		expect(second.testIdAttribute().attribute).toBe("data-tid");
		expect(
			second.environmentWarnings().map((diagnostic) => diagnostic.code),
		).not.toContain("testid-attribute-unresolved");
	});
});
