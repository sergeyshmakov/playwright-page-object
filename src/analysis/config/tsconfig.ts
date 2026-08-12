import * as fs from "node:fs";
import * as path from "node:path";
import { exports as resolveExports } from "resolve.exports";
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

/**
 * `extends` hops followed when fingerprinting a config for freshness.
 *
 * Counts configs actually *read*, not paths enqueued. An extensionless
 * `extends: "./base"` has two legal spellings and both are watched — a config
 * coming into existence changes the effective options as much as an edit does —
 * so counting enqueued paths spent the budget twice per hop and truncated a
 * four-deep chain at the halfway mark, silently dropping the outermost bases
 * from the fingerprint while TypeScript itself still applied them.
 *
 * `seen` is the termination argument and `MAX_WATCHED_CONFIGS` bounds the
 * width, so this is only a depth budget - and truncating it is silent, with the
 * same consequence the paragraph above describes. Generous rather than tight.
 */
const MAX_EXTENDS_HOPS = 32;

/**
 * Hard ceiling on watched paths, including the spellings that do not exist.
 *
 * The hop budget bounds the depth of the walk; this bounds its width, so an
 * `extends` array of many entries cannot make the list unbounded.
 */
const MAX_WATCHED_CONFIGS = 64;

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
	let hops = 0;
	while (
		queue.length > 0 &&
		hops < MAX_EXTENDS_HOPS &&
		chain.length < MAX_WATCHED_CONFIGS
	) {
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
		if (!existsFile(current)) {
			// A spelling that is not on disk. Watched — that is the whole point of
			// enqueueing both — but it contributes no `extends`, so charging it to
			// the hop budget would let phantoms decide how deep a real chain is
			// followed. Tested by existence rather than by the read result:
			// `ts.readConfigFile` hands back an empty config plus an error for a
			// file that is not there, so the config alone cannot tell them apart.
			continue;
		}
		hops += 1;
		const read = ts.readConfigFile(current, (file) => ts.sys.readFile(file));
		const extended: unknown = read.config?.extends;
		const specifiers =
			typeof extended === "string"
				? [extended]
				: Array.isArray(extended)
					? extended.filter((one): one is string => typeof one === "string")
					: [];
		for (const specifier of specifiers) {
			// A package specifier - `@repo/tsconfig/base.json` - is resolved rather
			// than skipped. The original reasoning was that `node_modules` changes
			// by install and the lockfile stat covers that, which is true for an
			// *installed* package and false for the case that matters: a linked
			// workspace package, whose base config is edited like any other source
			// file in the repository and moves neither the leaf tsconfig nor the
			// lockfile.
			if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) {
				queue.push(...packageExtends(path.dirname(current), specifier));
				continue;
			}
			const resolved = path.resolve(path.dirname(current), specifier);
			// Both spellings TypeScript accepts, and *whether or not they exist*.
			// Deciding by existence was the bug: a specifier that already ends in
			// `.json` and is not there yet became `base.json.json`, so the day the
			// real file appeared nothing was watching it — which is precisely the
			// case this fingerprint has to catch, since a config coming into
			// existence changes the effective options as much as an edit does.
			if (resolved.toLowerCase().endsWith(".json")) {
				queue.push(resolved);
			} else {
				queue.push(`${resolved}.json`, path.join(resolved, "tsconfig.json"));
			}
		}
	}
	return chain;
}

/**
 * The config a package-specifier `extends` names, found the way Node would.
 *
 * Walks up looking for `node_modules/<specifier>`, taking the first hit — which
 * is what makes a linked workspace package resolve to its real source rather
 * than to a copy. Only an existing file is returned: unlike the relative form,
 * there is no single canonical path to watch for one that does not exist yet,
 * and inventing one per ancestor directory would put a stat storm on a path
 * that runs per acquire.
 */
function packageExtends(fromDirectory: string, specifier: string): string[] {
	let directory = fromDirectory;
	for (;;) {
		const base = path.join(directory, "node_modules", specifier);
		const candidates = specifier.toLowerCase().endsWith(".json")
			? [base]
			: [`${base}.json`, path.join(base, "tsconfig.json")];
		for (const candidate of candidates) {
			if (existsFile(candidate)) {
				return [candidate];
			}
		}
		// The layout candidates missed, so ask the package itself. TypeScript
		// resolves an `extends` package specifier through the manifest, and a
		// config published as `exports: {".": "./base.json"}` or under `main` has
		// no `tsconfig.json` at the path above — which read as "no base config at
		// all", leaving every later call on compiler options that had moved.
		const nodeModules = path.join(directory, "node_modules");
		const declared = manifestExtends(nodeModules, specifier);
		if (declared) {
			// The manifest is watched alongside the config it names. Editing
			// `exports` remaps which file `extends` resolves to without touching
			// either end of the chain, so a fingerprint that skipped it left the
			// workspace on the old base until something else happened to move.
			return [
				path.join(nodeModules, splitSpecifier(specifier).name, "package.json"),
				declared,
			];
		}
		const parent = path.dirname(directory);
		if (parent === directory) {
			return [];
		}
		directory = parent;
	}
}

/** Package name and subpath of an `extends` specifier: `@a/b/c.json` -> `@a/b`, `./c.json`. */
function splitSpecifier(specifier: string): { name: string; subpath: string } {
	const parts = specifier.split("/");
	const count = specifier.startsWith("@") ? 2 : 1;
	const name = parts.slice(0, count).join("/");
	const rest = parts.slice(count).join("/");
	return { name, subpath: rest ? `./${rest}` : "." };
}

/** The config a package's own manifest points `specifier` at, if it exists. */
function manifestExtends(
	nodeModules: string,
	specifier: string,
): string | undefined {
	const { name, subpath } = splitSpecifier(specifier);
	const packageRoot = path.join(nodeModules, name);
	let manifest: Record<string, unknown>;
	try {
		manifest = JSON.parse(
			fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
		) as Record<string, unknown>;
	} catch {
		return undefined;
	}

	const targets: string[] = [];
	if (manifest.exports !== undefined) {
		try {
			// `types` *and* `require`, because TypeScript resolves an `extends`
			// specifier with both in its condition set. Taking only `require` (or,
			// as suggested, only `types`) watches whichever target the other
			// condition would have won — so an edit to the config actually in force
			// changes no stamp at all.
			targets.push(
				...(resolveExports(manifest, subpath, {
					require: true,
					conditions: ["types"],
				}) ?? []),
			);
		} catch {
			// An exports map that does not cover this subpath. The `main` fallback
			// below is still worth trying.
		}
	}
	if (subpath === ".") {
		for (const field of ["tsconfig", "main"]) {
			const value = manifest[field];
			if (typeof value === "string") {
				targets.push(value);
			}
		}
	}

	for (const target of targets) {
		const resolved = path.join(packageRoot, target);
		if (existsFile(resolved)) {
			return resolved;
		}
	}
	return undefined;
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
 * The directories a tsconfig's `include` patterns watch, as TypeScript computes
 * them.
 *
 * `parseJsonConfigFileContent` already produces this for exactly this purpose —
 * it is what `tsc --watch` registers recursive watches on — and
 * {@link tsConfigFileNames} was throwing it away. It is the only place the scan's
 * *directories*, as opposed to its files, exist anywhere in this codebase.
 *
 * The caller stats these to notice a file appearing in a directory that holds no
 * loaded source yet, which the file-level mtime sweep cannot see. Returns `[]`
 * when the config cannot be read; the caller then falls back to the timer.
 */
export function tsConfigWildcardDirectories(
	tsConfigFilePath: string,
): string[] {
	try {
		const read = ts.readConfigFile(tsConfigFilePath, (file) =>
			ts.sys.readFile(file),
		);
		if (read.error || !read.config) {
			return [];
		}
		const parsed = ts.parseJsonConfigFileContent(
			read.config,
			ts.sys,
			path.dirname(tsConfigFilePath),
		);
		return Object.keys(parsed.wildcardDirectories ?? {});
	} catch {
		return [];
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
