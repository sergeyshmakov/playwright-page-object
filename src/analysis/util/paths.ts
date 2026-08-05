import * as path from "node:path";

/** Converts any OS path to posix separators, collapsing `\\` runs. */
export function toPosix(input: string): string {
	return input.replace(/\\/g, "/");
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
 * Case-folded lookup key. Windows paths are case-insensitive, so two spellings
 * of the same file must collapse to one entry — but the displayed key keeps the
 * original casing.
 *
 * Only the *file* half is folded. Class names are case-sensitive in every
 * language the engine reads, so folding them would merge two distinct page
 * objects into one entry and let a lookup return the wrong class.
 */
export function keyFold(key: string): string {
	const hash = key.lastIndexOf("#");
	if (hash < 0) {
		return key.toLowerCase();
	}
	return `${key.slice(0, hash).toLowerCase()}${key.slice(hash)}`;
}

export function splitDefKey(key: string): { file: string; name: string } {
	const hash = key.lastIndexOf("#");
	if (hash < 0) {
		return { file: key, name: "" };
	}
	return { file: key.slice(0, hash), name: key.slice(hash + 1) };
}

const IGNORED_SEGMENTS = new Set([
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
]);

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
		if (IGNORED_SEGMENTS.has(segment)) {
			return true;
		}
	}
	return false;
}

export function isDeclarationFile(filePath: string): boolean {
	return /\.d\.[cm]?ts$/.test(filePath);
}

/**
 * Minimal glob matcher (`*`, `**`, `?`, `{a,b}`) over posix paths. The engine
 * only ever matches its own include/exclude options with it, so a full
 * `picomatch` dependency would not pay for itself.
 */
export function globToRegExp(glob: string): RegExp {
	let out = "";
	let index = 0;
	const pattern = toPosix(glob);
	while (index < pattern.length) {
		const char = pattern[index];
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				// `**/` consumes any number of directories, including none.
				if (pattern[index + 2] === "/") {
					out += "(?:.*/)?";
					index += 3;
					continue;
				}
				out += ".*";
				index += 2;
				continue;
			}
			out += "[^/]*";
			index += 1;
			continue;
		}
		if (char === "?") {
			out += "[^/]";
			index += 1;
			continue;
		}
		if (char === "{") {
			const end = pattern.indexOf("}", index);
			if (end > index) {
				const options = pattern.slice(index + 1, end).split(",");
				out += `(?:${options.map(escapeRegExp).join("|")})`;
				index = end + 1;
				continue;
			}
		}
		out += escapeRegExp(char);
		index += 1;
	}
	return new RegExp(`^${out}$`);
}

export function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchesAnyGlob(relPosix: string, globs: string[]): boolean {
	for (const glob of globs) {
		if (globToRegExp(glob).test(relPosix)) {
			return true;
		}
	}
	return false;
}
