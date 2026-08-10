import * as path from "node:path";
import picomatch from "picomatch";

/** Converts any OS path to posix separators, collapsing `\\` runs. */
export function toPosix(input: string): string {
	return input.replace(/\\/g, "/");
}

/**
 * A caller-supplied path, spelled the way the engine emits paths.
 *
 * Every path the engine reports is workspace-relative and posix-separated, but
 * a client will just as readily send `.\src\Home.ts` or `./src/Home.ts` for the
 * same file. Normalising both sides of a comparison here is what keeps a
 * conventional spelling from being read as "no such file".
 */
export function normalizeRelPath(input: string): string {
	let out = toPosix(input.trim());
	while (out.startsWith("./")) {
		out = out.slice(2);
	}
	return out;
}

/**
 * Workspace-relative posix path. Falls back to the posix absolute path when
 * `abs` lives outside `root` (e.g. a sibling package or a `node_modules` file).
 */
export function toPosixRelative(root: string, abs: string): string {
	const rel = path.relative(root, abs);
	if (rel === "") {
		return ".";
	}
	if (escapesRoot(rel) || path.isAbsolute(rel)) {
		return toPosix(abs);
	}
	return toPosix(rel);
}

/**
 * True when a relative path steps out of its base.
 *
 * `..` has to be a whole segment: a directory named `..config` is inside the
 * root even though the string starts with two dots.
 */
function escapesRoot(rel: string): boolean {
	const posix = toPosix(rel);
	return posix === ".." || posix.startsWith("../");
}

/** Canonical definition key: `"e2e/page-objects/CheckoutPage.ts#CheckoutPage"`. */
export function defKey(relFile: string, className: string): string {
	return `${toPosix(relFile)}#${className}`;
}

/**
 * Whether the host filesystem treats two spellings of a path as the same file.
 *
 * A platform check rather than a probe: writing a temp file to sniff the real
 * behaviour would cost an I/O round trip on a hot path, and the default for
 * every supported OS is well known (NTFS and APFS/HFS+ case-insensitive, ext4
 * and friends case-sensitive). A case-sensitive volume mounted on macOS, or a
 * case-sensitive directory on Windows, is the documented blind spot: there the
 * engine merges `Foo.ts` and `foo.ts`, exactly as it did on every platform
 * before.
 */
export function isCaseInsensitiveFileSystem(): boolean {
	return process.platform === "win32" || process.platform === "darwin";
}

/** Case-folds a path for lookups, but only where the filesystem does too. */
export function foldPath(filePath: string): string {
	return isCaseInsensitiveFileSystem() ? filePath.toLowerCase() : filePath;
}

/**
 * Case-folded lookup key. Windows and macOS paths are case-insensitive, so two
 * spellings of the same file must collapse to one entry — but the displayed key
 * keeps the original casing.
 *
 * On a case-sensitive filesystem nothing is folded: `pages/Foo.ts#Checkout` and
 * `pages/foo.ts#Checkout` are two different files there, and collapsing them
 * would silently drop one class from the registry and resolve its references to
 * the other.
 *
 * Only the *file* half is ever folded. Class names are case-sensitive in every
 * language the engine reads, so folding them would merge two distinct page
 * objects into one entry and let a lookup return the wrong class.
 */
export function keyFold(key: string): string {
	const hash = key.lastIndexOf("#");
	if (hash < 0) {
		return foldPath(key);
	}
	return `${foldPath(key.slice(0, hash))}${key.slice(hash)}`;
}

export function splitDefKey(key: string): { file: string; name: string } {
	const hash = key.lastIndexOf("#");
	if (hash < 0) {
		return { file: key, name: "" };
	}
	return { file: key.slice(0, hash), name: key.slice(hash + 1) };
}

/**
 * Directory names the engine never reads, whatever it is looking for.
 *
 * Exported because it is the single source of truth for two different shapes of
 * the same rule: {@link isIgnoredPath} filters a path after the fact, and
 * {@link ignoredExcludeGlobs} prunes the same directories *during* a glob, which
 * is what keeps a repository-wide sweep from descending into `node_modules`.
 */
export const IGNORED_SEGMENTS = [
	"node_modules",
	"dist",
	"build",
	"out",
	".git",
	"coverage",
	"playwright-report",
	"test-results",
	".next",
	".astro",
] as const;

const IGNORED_SEGMENT_SET: ReadonlySet<string> = new Set(IGNORED_SEGMENTS);

/** Negated globs pruning {@link IGNORED_SEGMENTS} under an absolute posix root. */
export function ignoredExcludeGlobs(rootPosix: string): string[] {
	const root = rootPosix.replace(/\/+$/, "");
	return IGNORED_SEGMENTS.map((segment) => `!${root}/**/${segment}/**`);
}

/**
 * True when a path produced by {@link toPosixRelative} did not stay inside the
 * root. `toPosixRelative` falls back to the absolute path, which on Windows is
 * drive-prefixed (`C:/…`) rather than slash-rooted — so both forms are checked,
 * and `..` is matched as a whole segment.
 */
export function isOutsideRoot(relPosix: string): boolean {
	return (
		relPosix === ".." ||
		relPosix.startsWith("../") ||
		relPosix.startsWith("/") ||
		/^[A-Za-z]:\//.test(relPosix)
	);
}

/** True when the posix path crosses a directory the engine never wants to read. */
export function isIgnoredPath(relPosix: string): boolean {
	for (const segment of relPosix.split("/")) {
		if (IGNORED_SEGMENT_SET.has(segment)) {
			return true;
		}
	}
	return false;
}

export function isDeclarationFile(filePath: string): boolean {
	return /\.d\.[cm]?ts$/.test(filePath);
}

export function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * How the engine reads a glob — picomatch, with no room for a second opinion.
 *
 * There used to be a hand-rolled matcher here on the grounds that the engine
 * only matched its own include/exclude options with it. `--src-dir` ended that:
 * a caller's pattern now reaches *two* engines, this one and ts-morph's
 * `addSourceFilesAtPaths`, which globs with picomatch through tinyglobby. Every
 * shape the hand-rolled matcher read differently — a star inside a brace, a
 * nested brace, a character class, an extglob, a trailing `**` over the
 * directory itself — selected files into the project that the scope predicate
 * then rejected, and the analysis came out silently empty.
 *
 * `dot: true` is not a detail: picomatch hides dotfiles by default and the
 * hand-rolled matcher had no such rule, so without it the recursive source glob
 * would stop seeing `src/.storybook/a.ts` — components the engine has to read.
 *
 * `nonegate: true` keeps a leading `!` literal. Negation is resolved exactly one
 * layer up, in `withNormalizedScope`, which rewrites a negated scope into an
 * `exclude` entry; letting picomatch also interpret it would both double-handle
 * the patterns that go through there and give the option bags that do not
 * (`DiscoverOptions.include` and friends) an incoherent any-of semantics, where
 * `["a/**", "!a/b/**"]` matches everything under `a/b` through the first
 * pattern anyway.
 *
 * `windows: false` pins the separator rules. Left unset, picomatch reads the
 * host's `path.sep`, so a Windows dev box would accept `src\a.ts` where CI on
 * Linux would not. Every path handed to {@link matchesAnyGlob} is
 * posix-separated already.
 */
const GLOB_OPTIONS = { dot: true, nonegate: true, windows: false };

/**
 * Compiled matchers, keyed by the pattern list they were built from.
 *
 * Every call site matches *every* scanned file against the same include or
 * exclude array, so the compile is paid once per scope rather than once per
 * pattern per file. The cache is dropped wholesale once it grows past the
 * handful of distinct scopes a session really uses — a long-lived MCP server
 * must not accumulate a matcher per workspace it has ever been asked about.
 */
const MATCHER_CACHE_LIMIT = 64;
const matcherCache = new Map<string, (input: string) => boolean>();

function globMatcher(globs: readonly string[]): (input: string) => boolean {
	const patterns = globs.map(toPosix);
	const key = JSON.stringify(patterns);
	const cached = matcherCache.get(key);
	if (cached) {
		return cached;
	}
	const matcher = picomatch(patterns, GLOB_OPTIONS);
	if (matcherCache.size >= MATCHER_CACHE_LIMIT) {
		matcherCache.clear();
	}
	matcherCache.set(key, matcher);
	return matcher;
}

/**
 * True when a workspace-relative posix path matches any of `globs`.
 *
 * Patterns are normalised to posix first: a caller may perfectly well spell one
 * `src\**\*.ts`, and under {@link GLOB_OPTIONS} a backslash would otherwise be
 * read as an escape rather than a separator.
 */
export function matchesAnyGlob(relPosix: string, globs: string[]): boolean {
	if (globs.length === 0) {
		return false;
	}
	return globMatcher(globs)(relPosix);
}

/**
 * True when a pattern is a glob rather than a plain path.
 *
 * Asked of picomatch rather than of a hand-written magic-character set, because
 * the verdict has to agree with the matcher that will read the pattern next: a
 * set of `[*?[\]{}]` called `src/@(foo|bar)` and `+(a|b).ts` plain paths, so the
 * scope normalizer expanded them as if they were directories and produced a
 * pattern that matched nothing at all.
 */
export function isGlobPattern(pattern: string): boolean {
	return picomatch.scan(toPosix(pattern)).isGlob;
}
