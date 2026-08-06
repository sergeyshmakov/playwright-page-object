import * as fs from "node:fs";
import * as path from "node:path";
import type { CompilerOptions } from "ts-morph";
import { ts } from "ts-morph";
import { toPosix } from "../util/paths";

export interface TsConfigLocation {
	/** Absolute path, or `null` when nothing usable was found. */
	path: string | null;
	source: "explicit" | "project-root" | "test-dir" | "none";
}

function existsFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

/**
 * Finds the tsconfig that best describes the project under analysis.
 *
 * Order: explicit option, `<projectRoot>/tsconfig.json`, then the nearest
 * `tsconfig.json` walking up from the Playwright `testDir` (a monorepo often
 * keeps the e2e tsconfig next to the specs rather than at the repo root).
 */
export function locateTsConfig(
	projectRoot: string,
	explicit?: string,
	testDir?: string,
): TsConfigLocation {
	if (explicit) {
		const absolute = path.isAbsolute(explicit)
			? explicit
			: path.resolve(projectRoot, explicit);
		if (existsFile(absolute)) {
			return { path: absolute, source: "explicit" };
		}
		return { path: null, source: "none" };
	}

	const atRoot = path.join(projectRoot, "tsconfig.json");
	if (existsFile(atRoot)) {
		return { path: atRoot, source: "project-root" };
	}

	if (testDir) {
		// Walks up to the project root, however deep `testDir` sits: a fixed hop
		// cap would silently analyse a deep monorepo e2e package as if it had no
		// tsconfig. The root itself was already checked above, so the walk stops
		// there rather than escaping into unrelated ancestors.
		const stopAt = path.resolve(projectRoot);
		let current = path.resolve(projectRoot, testDir);
		while (true) {
			const candidate = path.join(current, "tsconfig.json");
			if (existsFile(candidate)) {
				return { path: candidate, source: "test-dir" };
			}
			const parent = path.dirname(current);
			if (parent === current || current === stopAt) {
				break;
			}
			current = parent;
		}
	}

	return { path: null, source: "none" };
}

/**
 * The files a tsconfig selects, without building a project for them.
 *
 * This is the glob half of what `new Project({ tsConfigFilePath })` does, minus
 * the expensive half: reading and parsing every one of those files into an AST.
 * It exists so the `maxFiles` cap can refuse an oversized repository *before*
 * that allocation, not after.
 *
 * Returns `null` when the config cannot be read, in which case the caller has
 * to fall back to counting the loaded project.
 */
export function tsConfigFileNames(tsConfigFilePath: string): string[] | null {
	try {
		const read = ts.readConfigFile(tsConfigFilePath, (file) =>
			ts.sys.readFile(file),
		);
		if (read.error || !read.config) {
			return null;
		}
		const parsed = ts.parseJsonConfigFileContent(
			read.config,
			ts.sys,
			path.dirname(tsConfigFilePath),
		);
		// A stale entry in the `files` array is reported by `tsc` but still comes
		// back in `fileNames`, while the project only ever loads what exists. Left
		// in, it inflates the pre-scan count and rejects a repository that is
		// inside the cap. (Glob-derived names are on disk by construction, so this
		// only ever drops the `files` leftovers.)
		return parsed.fileNames.filter((fileName) => ts.sys.fileExists(fileName));
	} catch {
		return null;
	}
}

/**
 * Compiler options used when no tsconfig exists. Everything the engine needs is
 * syntactic, so these only have to make the parser produce the right AST.
 */
export function synthesizedCompilerOptions(): CompilerOptions {
	return {
		target: ts.ScriptTarget.ES2022,
		jsx: ts.JsxEmit.ReactJSX,
		// `.jsx` sources are in the fallback scan below, so the parser has to
		// accept them; nothing here is ever type-checked.
		allowJs: true,
		checkJs: false,
		noEmit: true,
		skipLibCheck: true,
		strict: false,
	};
}

/**
 * Extensions the scanner sweeps when it globs for source files.
 *
 * `.jsx` is included because the JSX scanner, the entry-point heuristic
 * (`main.jsx` / `index.jsx`) and the module resolver all support it — omitting
 * it would make a JavaScript React app silently unanalysable. Plain `.js` is
 * not swept: it would pull in build output and tooling config for every repo,
 * and any `.js` module actually imported from analysed code is added on demand
 * by the resolver.
 *
 * Every place that has to name this set — the no-tsconfig fallback, the bare
 * directory expansion behind `--src-dir`, and the diagnostic that tells the
 * caller what was scanned — derives it from here so the three cannot drift.
 */
export const SCAN_EXTENSIONS = ["ts", "tsx", "mts", "cts", "jsx"] as const;

/** The recursive glob for {@link SCAN_EXTENSIONS}, relative to a directory. */
export const SCAN_GLOB = `**/*.{${SCAN_EXTENSIONS.join(",")}}`;

/** Default globs used when the workspace has no tsconfig to enumerate files. */
export function defaultIncludeGlobs(projectRoot: string): string[] {
	const root = toPosix(projectRoot).replace(/\/$/, "");
	return SCAN_EXTENSIONS.map((extension) => `${root}/**/*.${extension}`);
}

export function defaultExcludeGlobs(projectRoot: string): string[] {
	const root = toPosix(projectRoot).replace(/\/$/, "");
	return [
		`!${root}/**/node_modules/**`,
		`!${root}/**/dist/**`,
		`!${root}/**/build/**`,
		`!${root}/**/coverage/**`,
		`!${root}/**/playwright-report/**`,
		`!${root}/**/test-results/**`,
	];
}
