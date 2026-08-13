import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A throwaway repository on disk, for the tests that genuinely need one.
 *
 * Most analysis tests use `makeWorkspace` and never touch the filesystem. These
 * are the ones that cannot: tsconfig discovery, Playwright-config reading,
 * mtime freshness, `node_modules` links — all questions about the disk itself,
 * which ts-morph's in-memory host does not model.
 *
 * Ten specs had grown their own copy of this, byte-identical apart from the
 * temp-directory prefix. That is cheap duplication rather than dangerous
 * duplication — nothing silently diverged — but it is ten places to edit the
 * day the cleanup or the realpath handling has to change.
 */

/** Roots created by this process, cleaned up by {@link cleanupScratchRoots}. */
const roots: string[] = [];

export interface ScratchOptions {
	/** Prefix for the temp directory, so a leaked root names its spec. */
	prefix?: string;
	/**
	 * Resolve the root through `realpath` before returning it.
	 *
	 * Only the specs that create symlinks need this: on macOS `os.tmpdir()` is
	 * `/var/…` while its real path is `/private/var/…`, so a fixture rooted at
	 * the former classifies its own linked files as outside the root. Off by
	 * default because it costs a syscall and changes the path the test sees.
	 */
	real?: boolean;
}

/** Writes `files` into a fresh temp directory and returns its absolute path. */
export function scratchRepo(
	files: Record<string, string>,
	options: ScratchOptions = {},
): string {
	const created = fs.mkdtempSync(
		path.join(os.tmpdir(), options.prefix ?? "ppo-"),
	);
	const root = options.real ? fs.realpathSync.native(created) : created;
	roots.push(root);
	for (const [relativePath, contents] of Object.entries(files)) {
		writeIn(root, relativePath, contents);
	}
	return root;
}

/**
 * Registers a path this module did not create for the same cleanup.
 *
 * For the symlink specs, which make a second spelling of a root *beside* it —
 * a sibling of the temp directory, so removing the root does not remove it.
 */
export function trackScratchRoot(root: string): string {
	roots.push(root);
	return root;
}

/** Writes one file under `root`, creating parent directories. */
export function writeIn(
	root: string,
	relativePath: string,
	contents: string,
): void {
	const absolute = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, contents, "utf8");
}

/**
 * Whether this filesystem lets the test process create a directory link.
 *
 * `fs.symlinkSync(target, link, "junction")` makes a directory junction on
 * Windows — which needs no elevation, unlike a *file* symlink — and an ordinary
 * directory symlink everywhere else, because POSIX ignores the type argument.
 * Restricted containers and some overlay mounts still refuse; those skip.
 */
export function canLink(): boolean {
	const probe = fs.mkdtempSync(path.join(os.tmpdir(), "ppo-linkprobe-"));
	try {
		fs.mkdirSync(path.join(probe, "target"));
		fs.symlinkSync(
			path.join(probe, "target"),
			path.join(probe, "link"),
			"junction",
		);
		return fs.existsSync(path.join(probe, "link"));
	} catch {
		return false;
	} finally {
		fs.rmSync(probe, { recursive: true, force: true });
	}
}

/** Removes every root this process created. Call from `afterAll`. */
export function cleanupScratchRoots(): void {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
}
