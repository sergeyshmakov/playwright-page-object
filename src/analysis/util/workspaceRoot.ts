import * as fs from "node:fs";
import type { Project } from "ts-morph";
import { foldPath, toPosix } from "./paths";

/**
 * Whether a resolved file belongs to the analysed workspace rather than to an
 * installed dependency.
 *
 * Judged by the file's REAL path, not the path we walked to reach it. npm, yarn
 * and pnpm workspaces publish local packages into `node_modules` as symlinks
 * (POSIX) or directory junctions (Windows), so
 * `<root>/node_modules/@acme/ui/src/X.tsx` and `<root>/packages/ui/src/X.tsx`
 * are the same file. Classifying by the link path makes every workspace package
 * an external boundary and empties the tree.
 *
 * Mirrors the established `util/fileBudget.ts` pattern — a `WeakMap<Project, …>`
 * the `Workspace` constructor registers — so `resolve.ts` keeps taking a
 * `Project` rather than a `Workspace`.
 */

const NODE_MODULES = "/node_modules/";

/**
 * The `node_modules` tests, folded exactly where {@link insideRoot} folds.
 *
 * A raw `includes` read `C:/Repo/Node_Modules/react/index.js` as first-party
 * source on a filesystem that resolves it to the installed dependency it is,
 * which is the one direction this predicate must never get wrong. Folding
 * preserves length, so an index into the folded string indexes the original.
 */
function hasNodeModulesSegment(posixPath: string): boolean {
	return foldPath(posixPath).includes(NODE_MODULES);
}

function lastNodeModulesIndex(posixPath: string): number {
	return foldPath(posixPath).lastIndexOf(NODE_MODULES);
}

interface RootRecord {
	/** Workspace root as configured, posix, case-folded. */
	root: string;
	/**
	 * The same root after `realpath`, case-folded. Kept alongside the literal one
	 * because either side of a comparison may be the linked spelling: on macOS
	 * `os.tmpdir()` is `/var/…` while its real path is `/private/var/…`, and a
	 * fixture rooted at the former would otherwise classify its own files as
	 * outside the root.
	 */
	realRoot: string;
	/** Directory path (posix) to its real path, or `null` when unreadable. */
	realDirs: Map<string, string | null>;
}

const roots = new WeakMap<Project, RootRecord>();

/**
 * Real path of `input`, posix, or `null` when the filesystem refuses.
 *
 * `realpathSync.native` rather than the JS implementation: on Windows it is the
 * one that reliably resolves directory junctions, and it canonicalises the
 * drive-letter case. It can answer with a `\\?\` extended-length prefix, which
 * is stripped here so the result compares against ordinary paths.
 *
 * The UNC form is stripped first and separately: `\\?\UNC\server\share` is the
 * extended spelling of `\\server\share`, so dropping the prefix outright would
 * leave `UNC\server\share` — a path that matches no root, is under no drive,
 * and turns every linked package on a network root into an external boundary.
 */
function realPathOf(input: string): string | null {
	try {
		const resolved = fs.realpathSync.native(input);
		return toPosix(
			resolved.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, ""),
		);
	} catch {
		// ENOENT, EPERM, an in-memory filesystem: a classification predicate never
		// throws, it falls back to the literal path.
		return null;
	}
}

/** Registers the analysed root. One workspace, one project, one root. */
export function registerWorkspaceRoot(project: Project, root: string): void {
	const posix = toPosix(root).replace(/\/+$/, "");
	roots.set(project, {
		root: foldPath(posix),
		realRoot: foldPath(realPathOf(posix) ?? posix),
		realDirs: new Map(),
	});
}

/** Whether the project has a registered root at all. */
export function hasWorkspaceRoot(project: Project): boolean {
	return roots.has(project);
}

/**
 * Real path of a directory, cached per project.
 *
 * Cached at the directory the caller asks about — callers pass a *package*
 * directory, so one workspace package costs one syscall however many of its
 * files are resolved.
 */
export function realDirectory(
	project: Project,
	dirPath: string,
): string | null {
	const posix = toPosix(dirPath).replace(/\/+$/, "");
	const record = roots.get(project);
	if (!record) {
		return realPathOf(posix);
	}
	const cached = record.realDirs.get(posix);
	if (cached !== undefined) {
		return cached;
	}
	const resolved = realPathOf(posix);
	record.realDirs.set(posix, resolved);
	return resolved;
}

/**
 * Forgets the cached directory real paths.
 *
 * A link is a fact about the filesystem, and the filesystem changes: a package
 * relinked, removed or newly installed between two calls of a long-lived server
 * would otherwise keep the classification the first call made. Called from the
 * workspace's epoch bump, which is exactly the event that says the files are
 * not what they were.
 */
export function clearRealPathCache(project: Project): void {
	roots.get(project)?.realDirs.clear();
}

function insideRoot(record: RootRecord, posixPath: string): boolean {
	const folded = foldPath(posixPath).replace(/\/+$/, "");
	for (const base of [record.root, record.realRoot]) {
		if (folded === base || folded.startsWith(`${base}/`)) {
			return true;
		}
	}
	return false;
}

/**
 * Whether a directory is inside the analysed workspace, by either spelling of
 * the root. Used to bound a directory walk; says nothing about links.
 */
export function isUnderWorkspaceRoot(
	project: Project,
	dirPath: string,
): boolean {
	const record = roots.get(project);
	return record !== undefined && insideRoot(record, toPosix(dirPath));
}

/**
 * Real path of a `node_modules/<pkg>` directory when that link leads back into
 * the workspace, or `null` when it is an ordinary installed dependency.
 */
export function linkedWorkspaceDirectory(
	project: Project,
	dirPath: string,
): string | null {
	const record = roots.get(project);
	if (!record) {
		return null;
	}
	const real = realDirectory(project, dirPath);
	if (real === null || hasNodeModulesSegment(real)) {
		return null;
	}
	return insideRoot(record, real) ? real : null;
}

/**
 * Splits `…/node_modules/<pkg>/rest` into the package directory and the rest.
 *
 * The *last* `node_modules` segment wins: a package nested inside another
 * package's `node_modules` is a dependency of a dependency however the outer
 * one is linked.
 */
function packagePrefix(
	posixPath: string,
): { packageDir: string; tail: string } | null {
	const at = lastNodeModulesIndex(posixPath);
	if (at < 0) {
		return null;
	}
	const after = posixPath.slice(at + NODE_MODULES.length);
	const segments = after.split("/");
	if (segments.length === 0 || segments[0] === "") {
		return null;
	}
	const spanned = segments[0].startsWith("@") ? 2 : 1;
	if (segments.length < spanned) {
		return null;
	}
	const name = segments.slice(0, spanned).join("/");
	return {
		packageDir: `${posixPath.slice(0, at + NODE_MODULES.length)}${name}`,
		tail: after.slice(name.length),
	};
}

/**
 * Real path of a file, resolved through the `node_modules` link that leads to
 * it, or `null` when there is no such link to follow.
 */
export function realFilePath(
	project: Project,
	filePath: string,
): string | null {
	const posix = toPosix(filePath);
	const split = packagePrefix(posix);
	if (!split) {
		return null;
	}
	const realPackage = realDirectory(project, split.packageDir);
	return realPackage === null ? null : `${realPackage}${split.tail}`;
}

/**
 * Real path of a file reached through a `node_modules` link that leads back
 * into the workspace, or `null` when there is no such link to follow: an
 * ordinary installed dependency, or no `node_modules` hop at all.
 *
 * The path a caller must load a linked package's file *by*. Loading it under
 * the link spelling puts it in the project as `node_modules/…`, which
 * `Workspace.sourceFiles()` drops — so its ids reach a tree and never reach the
 * inventory, and coverage calls every selector for them dead.
 */
export function linkedWorkspaceFile(
	project: Project,
	filePath: string,
): string | null {
	const split = packagePrefix(toPosix(filePath));
	if (!split) {
		return null;
	}
	const real = linkedWorkspaceDirectory(project, split.packageDir);
	return real === null ? null : `${real}${split.tail}`;
}

/**
 * Real path of a file reached through a `node_modules` link that lands on
 * ordinary source *outside* the analysed root, or `null` when there is no such
 * link: an installed dependency, a link back inside the root, or no hop at all.
 *
 * The mirror image of {@link linkedWorkspaceFile}, and the difference between
 * the two advisable answers when a component tag resolves out of scope. A link
 * leading to `<repo>/packages/ui/src` says the sources exist and the analysis is
 * simply rooted too deep — re-rooting brings them in. A path that stays inside
 * `node_modules` after the link is followed is a published package, and no
 * scope change can reach its ids.
 */
export function linkedOutsideRoot(
	project: Project,
	filePath: string,
): string | null {
	const record = roots.get(project);
	if (!record) {
		return null;
	}
	const real = realFilePath(project, toPosix(filePath));
	if (real === null || hasNodeModulesSegment(real)) {
		return null;
	}
	return insideRoot(record, real) ? null : real;
}

/** Directory levels the diagnostic probe walks up looking for `node_modules`. */
const MAX_DIAGNOSTIC_HOPS = 10;

/**
 * Real source directory of a package linked into a `node_modules` **above** the
 * analysed root, or `null`.
 *
 * The one place in the engine that deliberately looks outside the root, and the
 * reason is that it is a diagnosis rather than a resolution. `resolve.ts`'s
 * workspace-package probe stops at the root on purpose — a `node_modules`
 * outside it belongs to somebody else's project and its contents must never be
 * parsed — which is exactly why an analysis rooted at one app of a monorepo
 * reports its sibling packages as unresolvable. That is the right answer to
 * "can I read this?" and a useless one to "why can't I, and what would fix it?".
 *
 * Nothing is loaded, parsed or admitted here: it answers with a directory name
 * for a warning to quote. `null` covers every case where re-rooting would not
 * help — no link, a link that stays inside `node_modules` (an ordinary
 * installed dependency), or one that lands back inside the root, where the
 * analysis can already see it.
 */
export function packageSourceOutsideRoot(
	project: Project,
	fromDirectory: string,
	packageName: string,
): string | null {
	const record = roots.get(project);
	if (!record) {
		return null;
	}
	const fileSystem = project.getFileSystem();
	let directory = toPosix(fromDirectory).replace(/\/+$/, "");
	for (let hop = 0; hop < MAX_DIAGNOSTIC_HOPS; hop += 1) {
		const candidate = `${directory}/node_modules/${packageName}`;
		if (fileSystem.directoryExistsSync(candidate)) {
			const real = realDirectory(project, candidate);
			return real === null ||
				hasNodeModulesSegment(real) ||
				insideRoot(record, real)
				? null
				: real;
		}
		const parent = directory.slice(0, directory.lastIndexOf("/"));
		if (parent === "" || parent === directory || !parent.includes("/")) {
			return null;
		}
		directory = parent;
	}
	return null;
}

/**
 * Deepest directory containing every input, or `null` when they share none.
 *
 * Used to turn "these sources are outside the analysed root" into the one thing
 * a caller can act on: the directory to root the analysis at instead. Compared
 * case-folded (a Windows drive letter is spelled either way) while the answer
 * keeps the first input's spelling, and refused when the result is a filesystem
 * or drive root, which is never useful advice.
 */
export function commonAncestorDirectory(paths: string[]): string | null {
	if (paths.length === 0) {
		return null;
	}
	const split = paths.map((entry) =>
		toPosix(entry).replace(/\/+$/, "").split("/"),
	);
	const [first] = split;
	let shared = first.length;
	for (const segments of split.slice(1)) {
		let index = 0;
		while (
			index < shared &&
			index < segments.length &&
			foldPath(segments[index]) === foldPath(first[index])
		) {
			index += 1;
		}
		shared = index;
	}
	// One segment is `C:` or the empty string before a leading `/`: a drive or the
	// filesystem root, which no analysis should be pointed at.
	return shared < 2 ? null : first.slice(0, shared).join("/");
}

/**
 * Local ⇔ the path never went through `node_modules`, or the link it went
 * through lands back inside the (real) workspace root with no `node_modules`
 * segment left.
 *
 * Gated on the literal string first: a path with no `node_modules` segment can
 * never be an installed dependency, so it costs zero syscalls — which keeps the
 * common case (and the in-memory test filesystem, which models no links at all)
 * off the real filesystem entirely.
 *
 * Note what the root check does *not* do: a file outside the root that was
 * reached without a `node_modules` hop stays local, exactly as it was before
 * this predicate existed. A monorepo leaf whose tsconfig maps
 * `@acme/ui` to `../../packages/ui/src` is ordinary local source that the walk
 * has always followed, and refusing it here would empty the very trees this
 * predicate exists to fill. The root is what tells a *linked* workspace package
 * apart from an installed one, and that is the only judgement it is used for.
 */
export function isWorkspaceLocal(project: Project, filePath: string): boolean {
	const posix = toPosix(filePath);
	if (!hasNodeModulesSegment(posix)) {
		return true;
	}
	const record = roots.get(project);
	if (!record) {
		// A bare `Project` nobody registered — a unit test, typically. Without a
		// root there is nothing to judge a link against, so fall back to the string
		// test this predicate replaced.
		return false;
	}
	const real = realFilePath(project, posix);
	if (real === null || hasNodeModulesSegment(real)) {
		return false;
	}
	return insideRoot(record, real);
}
