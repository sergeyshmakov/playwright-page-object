import * as fs from "node:fs";
import * as path from "node:path";
import type { CompilerOptions } from "ts-morph";
import { ts } from "ts-morph";
import {
	ignoredExcludeGlobs,
	isOutsideRoot,
	toPosix,
	toPosixRelative,
} from "../util/paths";

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
		//
		// `current === stopAt` is the stop condition, and on its own it is only
		// reachable when `testDir` is *inside* the root. A config pointing outside
		// it - `testDir: "../e2e"`, an absolute path, a sibling package - walks a
		// chain that never passes through the root, so the loop ran to the
		// filesystem root and could select, then fully parse, an unrelated
		// ancestor's tsconfig. Starting outside means there is nothing to walk.
		const stopAt = path.resolve(projectRoot);
		const from = path.resolve(projectRoot, testDir);
		let current: string | null = isOutsideRoot(toPosixRelative(stopAt, from))
			? null
			: from;
		while (current !== null) {
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

/** `extends` hops followed when fingerprinting a config for freshness. */
const MAX_EXTENDS_HOPS = 8;

/**
 * Every tsconfig whose contents decide this one's effective options: the file
 * itself, then whatever it `extends`, transitively.
 *
 * A shared base is where a monorepo keeps `paths`, `jsx` and half its
 * `include` — so watching only the located config meant editing the base left
 * every later call analysing files under compiler options that no longer exist,
 * with nothing saying so. Returned as a list for the caller to stat rather than
 * stat'ed here, because the caller does that once per acquire and only re-reads
 * this when the root's own mtime moves.
 *
 * Bounded and cycle-safe: `extends` chains are short in practice, and a config
 * that extends itself is a real thing to find on disk.
 */
export function tsConfigChain(tsConfigFilePath: string): string[] {
	const chain: string[] = [];
	const seen = new Set<string>();
	const queue = [tsConfigFilePath];
	while (queue.length > 0 && chain.length < MAX_EXTENDS_HOPS) {
		const current = queue.shift();
		if (current === undefined) {
			break;
		}
		const key = toPosix(current);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		chain.push(current);
		const read = ts.readConfigFile(current, (file) => ts.sys.readFile(file));
		const extended: unknown = read.config?.extends;
		const specifiers =
			typeof extended === "string"
				? [extended]
				: Array.isArray(extended)
					? extended.filter((one): one is string => typeof one === "string")
					: [];
		for (const specifier of specifiers) {
			// Relative and rooted forms only. A package specifier resolves through
			// `node_modules`, which an install changes rather than an edit — that is
			// the lockfile stat's job, not this one's.
			if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) {
				continue;
			}
			const resolved = path.resolve(path.dirname(current), specifier);
			queue.push(existsFile(resolved) ? resolved : `${resolved}.json`);
		}
	}
	return chain;
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
 *
 * `verifyExists` is on by default and costs one `stat` per selected file. A
 * caller that is about to try loading each name — where a name that is not
 * there simply loads nothing — should pass `false` and skip several thousand
 * syscalls; a caller that is *counting* has to pay for them (see below).
 */
export function tsConfigFileNames(
	tsConfigFilePath: string,
	{ verifyExists = true }: { verifyExists?: boolean } = {},
): string[] | null {
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
		if (!verifyExists) {
			return parsed.fileNames;
		}
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

/**
 * The directories every scan prunes, derived from the same
 * {@link IGNORED_SEGMENTS} list `isAnalysable()` filters on. Two hand-kept lists
 * drifted: the glob still descended into `out/`, `.git/`, `.next/` and
 * `.astro/`, parsing files the workspace then discarded.
 */
export function defaultExcludeGlobs(projectRoot: string): string[] {
	return ignoredExcludeGlobs(toPosix(projectRoot).replace(/\/$/, ""));
}
