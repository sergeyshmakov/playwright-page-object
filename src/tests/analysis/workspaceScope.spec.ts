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
} from "./helpers/workspaceScratch";

beforeEach(clearPool);
afterEach(cleanupWorkspaces);

describe("Workspace scope diagnostics", () => {
	it("warns when an analysed directory is not on disk", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const ws = pool.acquire({
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
		const ws = pool.acquire({
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
		const ws = pool.acquire({
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
		const ws = pool.acquire({
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
		const ws = pool.acquire({
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
		const ws = pool.acquire(options);
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
		const ws = pool.acquire({
			projectRoot: root,
			include: ["src/[draft].ts"],
		});
		expect(rels(ws)).toEqual(["src/[draft].ts"]);
	});

	it("says nothing about an excluded directory that is not there", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const ws = pool.acquire({ projectRoot: root, exclude: ["generated"] });
		expect(ws.warnings.map((diagnostic) => diagnostic.code)).not.toContain(
			"scope-dir-missing",
		);
	});

	it("reports an empty JSX scope through environmentWarnings", () => {
		const root = scratch({ "e2e/Page.ts": "export class Page {}" });
		const ws = pool.acquire({ projectRoot: root });
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
		const ws = pool.acquire({ projectRoot: root });
		const codes = ws.environmentWarnings().map((one) => one.code);
		expect(codes[0]).toBe("attribute-mismatch");
		expect(codes).toContain("playwright-config-not-found");
	});

	it("memoizes environmentWarnings per epoch and per attribute", () => {
		const root = scratch({ "src/App.tsx": "export const A = () => <b/>;" });
		const ws = pool.acquire({ projectRoot: root });
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
		const ws = pool.acquire({
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
		const ws = pool.acquire({
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
		const ws = pool.acquire({ projectRoot: root, include: ["src/**"] });
		expect(rels(ws)).toEqual(["src/a.ts"]);
	});
});

/**
 * The config candidate list is the one cache an epoch bump does not clear: an
 * edit changes what a config *says*, never which files exist, and re-globbing
 * the repository on every keystroke would put a filesystem walk on the hot path.
 */

describe("Workspace include normalization", () => {
	const tree = {
		"src/a.ts": "export const a = 1;",
		"src/nested/b.tsx": "export const B = () => null;",
		"other/c.ts": "export const c = 1;",
	};

	it("expands a bare directory into a recursive source glob", () => {
		const root = scratch(tree);
		const ws = pool.acquire({ projectRoot: root, include: ["src"] });
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
		const ws = pool.acquire({ projectRoot: root, include: ["src"] });
		expect(rels(ws)).toEqual(["src/App.jsx", "src/legacy.cts", "src/util.mts"]);
	});

	it("expands a directory written with a trailing slash", () => {
		const root = scratch(tree);
		const ws = pool.acquire({ projectRoot: root, include: ["src/"] });
		expect(rels(ws)).toEqual(["src/a.ts", "src/nested/b.tsx"]);
	});

	it("expands a directory written with Windows separators", () => {
		const root = scratch(tree);
		const ws = pool.acquire({
			projectRoot: root,
			include: ["src\\nested"],
		});
		expect(rels(ws)).toEqual(["src/nested/b.tsx"]);
	});

	it("expands an absolute directory inside the root", () => {
		const root = scratch(tree);
		const ws = pool.acquire({
			projectRoot: root,
			include: [path.join(root, "src")],
		});
		expect(rels(ws)).toEqual(["src/a.ts", "src/nested/b.tsx"]);
	});

	it("expands `.` to the whole root", () => {
		const root = scratch(tree);
		const ws = pool.acquire({ projectRoot: root, include: ["."] });
		expect(rels(ws)).toEqual(["other/c.ts", "src/a.ts", "src/nested/b.tsx"]);
	});

	it("leaves a real glob untouched", () => {
		const root = scratch(tree);
		const ws = pool.acquire({ projectRoot: root, include: ["src/*.ts"] });
		expect(rels(ws)).toEqual(["src/a.ts"]);
	});

	it("leaves a single file path untouched", () => {
		const root = scratch(tree);
		const ws = pool.acquire({ projectRoot: root, include: ["src/a.ts"] });
		expect(rels(ws)).toEqual(["src/a.ts"]);
	});

	it("expands a bare directory in `exclude` too", () => {
		const root = scratch(tree);
		const ws = pool.acquire({ projectRoot: root, exclude: ["src"] });
		expect(rels(ws)).toEqual(["other/c.ts"]);
	});

	it("expands a directory whose name ends in a dot segment", () => {
		const root = scratch({
			"foo.config/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 1;",
		});
		const ws = pool.acquire({
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
		const ws = pool.acquire({ projectRoot: root, include: [".config"] });
		expect(rels(ws)).toEqual([".config/a.ts"]);
	});

	it("excludes a dotted directory instead of matching nothing", () => {
		const root = scratch({
			"foo.config/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 1;",
		});
		const ws = pool.acquire({
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
		const ws = pool.acquire({ projectRoot: root, include: ["src/a.ts"] });
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
		const ws = pool.acquire({
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
		const ws = pool.acquire({
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
		const ws = pool.acquire({
			projectRoot: root,
			include: ["src", "!src/nope"],
		});
		expect(ws.warnings.map((warning) => warning.code)).not.toContain(
			"scope-dir-missing",
		);
		expect(rels(ws)).toEqual(["src/a.ts", "src/generated/b.ts"]);
	});
});
