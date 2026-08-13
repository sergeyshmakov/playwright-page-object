import * as fs from "node:fs";
import * as path from "node:path";
import { SCAN_GLOB } from "./config/tsconfig";
import { isGlobPattern, toPosix } from "./util/paths";
import type { WorkspaceOptions } from "./workspace";

/**
 * Turning what a caller *said* to analyse into what the scanner can match.
 *
 * A scope arrives as whatever a human or an MCP client typed: a directory, a
 * single file, an absolute path, a glob, a `!` negation, a trailing slash.
 * Everything downstream - `addSourceFilesAtPaths`, `sourceFiles()`, `rescan()`
 * - matches include patterns literally against workspace-relative paths, so
 * every one of those spellings has to become a glob exactly once, here, at the
 * boundary. Normalising twice is as wrong as not at all: the normalized
 * patterns are part of the cache key.
 *
 * The module also reports what it could not find. A `--src-dir` naming a
 * directory that is not there expands to a glob matching nothing, and the
 * analysis then describes an empty project as though the repository were
 * empty; {@link withNormalizedScope} hands those names back so the caller can
 * say so out loud.
 */

/**
 * The analysed root, absolute. Every path the workspace emits is relative to
 * this, and it is the base every scope glob is resolved against - so it has to
 * be the same string in the cache key, in the project and in the normalizer.
 */
export function normalizeRoot(projectRoot: string): string {
	return path.resolve(projectRoot);
}

/**
 * Extensions the scanner can actually select a single file with. A trailing
 * `.config` or `.partials` is *not* one of them: those are directory names.
 */
const SOURCE_FILE_EXTENSION = /\.[cm]?[jt]sx?$/i;
/**
 * What a bare directory pattern expands to: exactly the set the default scan
 * sweeps, `.jsx` included. Anything narrower would make `--src-dir src` hide
 * every component of a JavaScript React app.
 */
const DIRECTORY_EXPANSION = SCAN_GLOB;

/** Posix pattern relative to `root`, when it points inside `root` at all. */
function relativizeToRoot(root: string, pattern: string): string {
	const posixPattern = toPosix(pattern);
	if (!path.isAbsolute(pattern) && !path.posix.isAbsolute(posixPattern)) {
		return posixPattern;
	}
	const relative = toPosix(path.relative(root, pattern));
	if (relative === "") {
		return ".";
	}
	return relative.startsWith("../") || path.posix.isAbsolute(relative)
		? posixPattern
		: relative;
}

/**
 * One `stat` answering both questions a scope pattern raises: whether it names
 * a single file rather than a directory, and whether it is there at all.
 *
 * Disk wins on the first question when the path exists, because a directory may
 * perfectly well be called `foo.config` or `.config` — treating it as a file by
 * its trailing dot segment left the pattern matching nothing at all and produced
 * a silently empty project. Only when nothing is there to stat does the
 * extension decide, and then only for extensions the scanner can really select
 * a file with.
 *
 * Both answers come from one syscall: asking twice cost a second `stat` per
 * pattern and let the two verdicts disagree.
 */
function statScope(
	root: string,
	body: string,
): { singleFile: boolean; exists: boolean } {
	try {
		return {
			singleFile: fs.statSync(path.resolve(root, body)).isFile(),
			exists: true,
		};
	} catch {
		return { singleFile: SOURCE_FILE_EXTENSION.test(body), exists: false };
	}
}

/**
 * Rewrites a directory into the recursive source glob it stands for.
 *
 * `--src-dir src` is documented as a directory, but include/exclude patterns
 * are matched literally against workspace-relative file paths, where `src`
 * only ever equals the directory entry itself - never `src/page.ts`. Patterns
 * that already carry glob magic, or that name a single file, are left alone.
 */
function normalizeScopePattern(
	root: string,
	pattern: string,
): { pattern: string; missing?: string } {
	const negated = pattern.startsWith("!");
	const body = relativizeToRoot(root, negated ? pattern.slice(1) : pattern)
		.replace(/\/+$/, "")
		.replace(/^\.\//, "");
	let normalized: string;
	let missing: string | undefined;
	if (body === "" || body === ".") {
		normalized = DIRECTORY_EXPANSION;
	} else if (isGlobPattern(body)) {
		normalized = body;
	} else {
		const stat = statScope(root, body);
		normalized = stat.singleFile ? body : `${body}/${DIRECTORY_EXPANSION}`;
		if (!stat.exists) {
			missing = body;
		}
	}
	const out = negated ? `!${normalized}` : normalized;
	// A missing *exclusion* excludes nothing, which is what the caller wanted
	// anyway; only a missing inclusion silently empties the scope.
	return missing !== undefined && !negated
		? { pattern: out, missing }
		: { pattern: out };
}

/**
 * Normalizes the scoping options once, at the workspace boundary, so every
 * consumer (`addSourceFilesAtPaths`, `sourceFiles()`, `rescan()`) sees the
 * same globs — and reports back which of them name nothing on disk.
 *
 * A negated scope becomes an ordinary exclusion here, which is the only place
 * it can. `--src-dir '!src/generated'` is documented as "scan everything except
 * that directory", but every consumer downstream matches include patterns
 * literally: the `!` was read as the first character of a directory name, so
 * the pattern matched nothing, the include list was nonempty, and the analysed
 * scope came out empty. Alongside a positive scope it was worse than useless —
 * the positive pattern matched, and the exclusion the caller wrote was simply
 * not applied.
 */
export function withNormalizedScope(options: WorkspaceOptions): {
	options: WorkspaceOptions;
	missing: string[];
} {
	if (!options.include?.length && !options.exclude?.length) {
		return { options, missing: [] };
	}
	const root = normalizeRoot(options.projectRoot);
	const missing: string[] = [];
	const include: string[] = [];
	const exclude: string[] = [];
	const normalize = (
		patterns: string[] | undefined,
		collect: boolean,
		positive: string[],
	): void => {
		for (const pattern of patterns ?? []) {
			const result = normalizeScopePattern(root, pattern);
			// An `exclude` naming a directory that is not there excludes exactly the
			// nothing the caller wanted excluded. Only a missing *include* silently
			// empties the analysed scope.
			if (collect && result.missing !== undefined) {
				missing.push(result.missing);
			}
			if (result.pattern.startsWith("!")) {
				exclude.push(result.pattern.slice(1));
				continue;
			}
			positive.push(result.pattern);
		}
	};
	normalize(options.include, true, include);
	normalize(options.exclude, false, exclude);
	return { options: { ...options, include, exclude }, missing };
}

/**
 * The caller's `exclude` scope, spelled as negated globs for the file adder.
 *
 * `exclude` used to be honoured only by the scope predicate — that is, after
 * every excluded file had already been globbed, read and parsed. Parsing is the
 * cost `maxFiles` governs (it counts what the project holds, not what the
 * answers show), so `--src-dir src --src-dir '!src/generated'` could still be
 * refused with `max_files_exceeded` over a directory it had just been told to
 * ignore. These are the very patterns `sourceFiles()` filters with, normalized
 * once in {@link withNormalizedScope}, so the glob and the predicate cannot
 * disagree about what is out of scope.
 *
 * Only the glob-driven scans can carry them. A tsconfig-backed project with no
 * `include` takes its file set from the tsconfig itself, which is the file set
 * TypeScript would compile; narrowing that is `exclude`'s job downstream.
 */
export function scopeExcludeGlobs(
	root: string,
	exclude: readonly string[] | undefined,
): string[] {
	return (exclude ?? []).map((glob) => absoluteGlob(root, `!${glob}`));
}

export function absoluteGlob(root: string, glob: string): string {
	const posixGlob = toPosix(glob);
	if (posixGlob.startsWith("!")) {
		const body = posixGlob.slice(1);
		return `!${path.posix.isAbsolute(body) ? body : path.posix.join(toPosix(root), body)}`;
	}
	return path.posix.isAbsolute(posixGlob)
		? posixGlob
		: path.posix.join(toPosix(root), posixGlob);
}

export function isJsxFile(filePath: string): boolean {
	return /\.[jt]sx$/.test(filePath);
}
