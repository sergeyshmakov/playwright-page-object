import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateServerOptions } from "../../mcp/options";

/**
 * Startup validation.
 *
 * Every mistake here is silent at runtime: a mistyped `--project-root` analyses
 * an empty directory, a mistyped `--src-dir` narrows the scope to nothing, and
 * a mistyped `--playwright-config` used to fall through to discovery and answer
 * with some other file's attribute. A stdio server then serves that wrong
 * answer for the rest of the session, so startup is the last moment a human
 * still reads the message.
 */

let root: string;

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ppo-opts-"));
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;");
	fs.writeFileSync(path.join(root, "tsconfig.json"), "{}");
	fs.writeFileSync(
		path.join(root, "playwright.config.ts"),
		"export default {};",
	);
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("validateServerOptions", () => {
	it("accepts a fully valid set of paths", () => {
		expect(
			validateServerOptions({
				projectRoot: root,
				tsconfig: "tsconfig.json",
				playwrightConfig: "playwright.config.ts",
				srcDirs: ["src"],
			}),
		).toEqual([]);
	});

	it("accepts the bare minimum", () => {
		expect(validateServerOptions({ projectRoot: root })).toEqual([]);
	});

	it("rejects a project root that is not a directory", () => {
		const problems = validateServerOptions({
			projectRoot: path.join(root, "src", "a.ts"),
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("--project-root");
	});

	it("rejects a project root that does not exist", () => {
		const problems = validateServerOptions({
			projectRoot: path.join(root, "nope"),
		});
		expect(problems[0]).toContain("--project-root");
	});

	it("rejects a missing tsconfig and a missing playwright config", () => {
		const problems = validateServerOptions({
			projectRoot: root,
			tsconfig: "tsconfig.build.json",
			playwrightConfig: "config/pw.ts",
		});
		expect(problems).toHaveLength(2);
		expect(problems[0]).toContain("--tsconfig");
		expect(problems[1]).toContain("--playwright-config");
	});

	it("rejects a tsconfig path that names a directory", () => {
		const problems = validateServerOptions({
			projectRoot: root,
			tsconfig: "src",
		});
		expect(problems[0]).toContain("--tsconfig");
	});

	it("shows the resolved tsconfig path and suggests a cwd-relative correction", () => {
		const projectRoot = path.join(process.cwd(), "example");
		const problems = validateServerOptions({
			projectRoot,
			tsconfig: "example/tsconfig.json",
		});
		const expected = path.join(projectRoot, "example", "tsconfig.json");

		expect(problems).toEqual([
			`--tsconfig is not a file: ${expected} (resolved from "example/tsconfig.json" against --project-root ${projectRoot}); did you mean --tsconfig "tsconfig.json"?`,
		]);
	});

	it("does not claim an absolute tsconfig was resolved against the root", () => {
		const missing = path.join(root, "nope", "tsconfig.json");
		expect(
			validateServerOptions({ projectRoot: root, tsconfig: missing }),
		).toEqual([`--tsconfig is not a file: ${missing}`]);
	});

	it("names every missing src dir, not just the first", () => {
		const problems = validateServerOptions({
			projectRoot: root,
			srcDirs: ["src", "apps/web", "packages/ui"],
		});
		expect(problems).toEqual([
			"--src-dir does not exist: apps/web",
			"--src-dir does not exist: packages/ui",
		]);
	});

	// A glob is validated by matching it, and a `!` entry is an exclusion whose
	// target legitimately may not be there. Stat'ing either would refuse to start
	// over a perfectly good scope.
	it("leaves globs and negations alone", () => {
		expect(
			validateServerOptions({
				projectRoot: root,
				srcDirs: ["src/**/*.tsx", "!generated"],
			}),
		).toEqual([]);
	});

	/**
	 * Startup used to classify a scope with its own `[*?[\]{}]` regex, which reads
	 * every extglob without a star in it — `@(a|b)`, `+(a|b)`, `?(a)`, `!(a)` — as
	 * a plain path, stats it, does not find it and refuses to start. The engine
	 * scans with picomatch, so this asks picomatch too, through the one exported
	 * verdict both sides share.
	 */
	it("recognizes an extglob scope as a pattern rather than a path", () => {
		expect(
			validateServerOptions({
				projectRoot: root,
				srcDirs: [
					"src/@(App|Admin).tsx",
					"src/+(a|b).ts",
					"src/?(only).ts",
					"src/!(generated)/**",
				],
			}),
		).toEqual([]);
	});

	it("accepts absolute paths", () => {
		expect(
			validateServerOptions({
				projectRoot: root,
				tsconfig: path.join(root, "tsconfig.json"),
				srcDirs: [path.join(root, "src")],
			}),
		).toEqual([]);
	});

	/**
	 * The analysis drops every path outside the root before it counts anything, so
	 * a scope pointing outside contributes no file at all. The server used to
	 * start on one and answer every call with an empty index, saying nothing about
	 * why — the exact silent-wrong startup this validation exists to prevent.
	 */
	it("rejects a src dir outside the project root", () => {
		const outside = path.dirname(root);
		expect(
			validateServerOptions({ projectRoot: root, srcDirs: [outside] }),
		).toEqual([`--src-dir is outside --project-root: ${outside}`]);
	});

	it("rejects a relative src dir that climbs out of the root", () => {
		expect(
			validateServerOptions({ projectRoot: root, srcDirs: ["../elsewhere"] }),
		).toEqual(["--src-dir is outside --project-root: ../elsewhere"]);
	});

	// Only one complaint per scope: "outside the root" already says why the path
	// is unusable, and stat'ing it would add "does not exist" about a directory
	// that would be refused even if it were there.
	it("says only that an outside src dir is outside", () => {
		const problems = validateServerOptions({
			projectRoot: root,
			srcDirs: ["../nope/missing"],
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("outside --project-root");
	});

	it("still accepts the root itself and a nested directory", () => {
		expect(
			validateServerOptions({ projectRoot: root, srcDirs: [".", "src"] }),
		).toEqual([]);
	});
});
