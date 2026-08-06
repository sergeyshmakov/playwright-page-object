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
 */
function realPathOf(input: string): string | null {
	try {
		const resolved = fs.realpathSync.native(input);
		return toPosix(resolved.replace(/^\\\\\?\\/, ""));
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
	if (real === null || real.includes(NODE_MODULES)) {
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
	const at = posixPath.lastIndexOf(NODE_MODULES);
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
	if (!posix.includes(NODE_MODULES)) {
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
	if (real === null || real.includes(NODE_MODULES)) {
		return false;
	}
	return insideRoot(record, real);
}
