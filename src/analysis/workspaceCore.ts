import * as fs from "node:fs";
import * as path from "node:path";
import {
	FileSystemRefreshResult,
	type Project,
	type SourceFile,
} from "ts-morph";
import { isPlaywrightConfigPath } from "./config/configDiscovery";
import {
	locateTsConfig,
	tsConfigChain,
	tsConfigWildcardDirectories,
} from "./config/tsconfig";
import { dedupeDiagnostics, warn } from "./diagnostics";
import { globStaticBase, toPosix } from "./util/paths";
import { configDirOf, planProject } from "./workspaceBuild";
import {
	DEFAULT_STALE_AFTER_MS,
	UNKNOWN_TOTAL,
	WorkspaceFiles,
} from "./workspaceFiles";
import type { RevalidateResult, WorkspaceOptions } from "./workspaceOptions";
import { withNormalizedScope } from "./workspaceScope";

/**
 * Stamp for a scan root that was not on disk at the last sweep.
 *
 * Negative, so it can never equal an `mtimeMs`, which makes the transition to a
 * real stamp compare unequal and register as a change — the point being that a
 * scan directory coming into existence is exactly as significant as one whose
 * contents moved.
 */
const MISSING_DIR = -1;
/**
 * How far above the analysed root to look for the lockfile that governs it.
 *
 * A backstop only - the walk normally stops at the first lockfile or at the
 * `.git` boundary, both of which are within a hop or two of any real package.
 */
const MAX_LOCKFILE_ANCESTORS = 16;
/** Every lockfile the four package managers write, stat'ed as one signal. */
const LOCKFILE_NAMES = [
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lockb",
];

/** A file's mtime as a comparable string, or a stable marker when it is gone. */
function mtimeOf(filePath: string): string {
	try {
		return String(fs.statSync(filePath).mtimeMs);
	} catch {
		return "missing";
	}
}

/**
 * Owns the ts-morph `Project` for one analysed root.
 *
 * Invalidation is an mtime sweep per call rather than `fs.watch`: it is
 * stateless, survives branch switches and bulk checkouts, needs no debounce,
 * and behaves on network or virtualised filesystems where watch events are
 * unreliable.
 */
export class Workspace extends WorkspaceFiles {
	/**
	 * Fingerprint of the inputs that decided what this `Project` *is*, as of the
	 * last acquire. See {@link projectIdentity}.
	 */
	private identity: string | null = null;
	/** Summed lockfile mtimes as of the last sweep. See {@link lockfileChanged}. */
	private lockfileStamp: number | null = null;
	/** Last known mtime per scanned directory. See {@link scanDirsChanged}. */
	private readonly scanDirMtimes = new Map<string, number>();
	/** The tsconfig's wildcard directories, cached against its own mtime. */
	private wildcardDirs: {
		root: string;
		stamp: string;
		paths: string[];
	} | null = null;
	/**
	 * The located tsconfig's `extends` chain, cached against the root's own mtime
	 * so {@link projectIdentity} stats the chain per acquire but only re-reads it
	 * when the root changes.
	 */
	private tsconfigChain: {
		root: string;
		rootStamp: string;
		paths: string[];
	} | null = null;

	/**
	 * Whether this workspace can still answer for `options`, after bringing it
	 * up to date. Only {@link WorkspacePool} calls this.
	 *
	 * A pair with {@link build}: between them they are everything a cache has to
	 * do to a workspace, which is why the two of them are the whole opening this
	 * class makes for one. A pool that had to reach for `revalidate`,
	 * `projectIdentityChanged` and four seeding calls in the right order would be
	 * holding this class's invariants on its behalf.
	 */
	reuseFor(options: WorkspaceOptions, missing: string[]): boolean {
		// Latest caller wins. `staleAfterMs` is a freshness policy, not part of
		// the workspace's identity, so a caller asking for immediate rescans
		// gets them even though an earlier caller built the workspace with a
		// long interval — and an omitted value means this caller wants the
		// default, not whatever the first one happened to pass.
		this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
		if (options.revalidate !== false) {
			this.revalidate();
			// After the sweep, so the config read behind this is the edited one.
			//
			// `testDir` or the tsconfig moved, so this project holds the wrong files
			// under the wrong compiler options and no sweep can fix that — the file
			// set was decided when it was built. Rebuilding is the only correct
			// answer, and it happens in the pool rather than here because a method
			// cannot replace `this`.
			if (this.projectIdentityChanged()) {
				return false;
			}
		}
		this.noteMissingScope(missing);
		return true;
	}

	/**
	 * Tells this workspace how to remove itself from the cache holding it. Only
	 * {@link WorkspacePool} calls this. See {@link evictSelf}.
	 */
	heldBy(evict: () => void): void {
		this.evictSelf = evict;
	}

	/**
	 * A new workspace, seeded so that the first comparison against it is
	 * meaningful. Only {@link WorkspacePool} calls this.
	 */
	static build(options: WorkspaceOptions, missing: string[]): Workspace {
		const created = Workspace.create(options);
		created.noteMissingScope(missing);
		// Seeded from the real workspace, not from the throwaway probe `create`
		// used: the probe carries no tsconfig, so a base config reached through a
		// `paths` alias reads differently there. Comparing the two would find a
		// difference on the very first acquire and rebuild a 2.3 s project on every
		// single call. Both sides of every later comparison come from here.
		created.rememberProjectIdentity();
		// The lockfile baseline belongs here too, before any tool call can populate
		// a resolver cache. Seeded on the first *sweep* instead, an install landing
		// between call one and call two recorded the post-install stamp and
		// reported no change - so the caches call one filled were never cleared and
		// every later call saw the same stamp, leaving a newly linked package
		// misclassified for the rest of the session.
		created.lockfileChanged();
		// Same reason, and the same mistake avoided: seeded before any tool call,
		// so a file created between construction and the second acquire is a
		// difference rather than the baseline.
		created.scanDirsChanged();
		return created;
	}

	/**
	 * The inputs that decided which files this `Project` holds and how they parse.
	 *
	 * Not the same question as "did a source file change". The mtime sweep keeps
	 * the *contents* of the file set current and can add or drop files the globs
	 * already cover, but the set itself — which tsconfig supplied the compiler
	 * options, which directory the scan was rooted at — was fixed at construction.
	 * Edit `testDir` in `playwright.config.ts` and every later call answers from a
	 * project built for the old one: the right shape of answer, about the wrong
	 * directory, with nothing saying so.
	 *
	 * Idle eviction does not cover this. `touch()` restarts on every acquire, so
	 * the timer measures silence, and an agent that edits a config and immediately
	 * asks again is the opposite of silent — it keeps the stale project for the
	 * whole working burst, which is exactly when it is being read.
	 *
	 * `null` when it cannot be read at all — reading it parses the Playwright
	 * config, and on a repository at its file cap that parse is exactly what
	 * `maxFiles` refuses. Failing to answer must not turn into an answer, and it
	 * must not move that refusal into `acquire`: the tool call raises it where it
	 * always did.
	 */
	private projectIdentity(): string | null {
		if (this.inMemory) {
			return "";
		}
		try {
			const playwright = this.playwright();
			// Same rule as `create`: an unresolved `testDir` is left unknown rather
			// than replaced by the config's own directory.
			const testDir = playwright.testDirUnresolved
				? undefined
				: (playwright.testDir ?? configDirOf(playwright.configFile));
			const located = locateTsConfig(this.root, this.options.tsconfig, testDir);
			// The tsconfig's mtime as well as its path: `include`, `exclude` and
			// `paths` all decide the file set, and editing them in place leaves the
			// path identical. And the whole `extends` chain, not just the located
			// file — a shared base is where a monorepo keeps `paths` and half its
			// `include`, so watching only the leaf left an edit to the base
			// invisible.
			//
			// The chain itself is only re-read when the root's own mtime moves;
			// every other acquire just stats the paths it already knows. Re-parsing
			// a config stack on the hot path would be a real cost, and the root's
			// mtime is exactly what changes when its `extends` list does.
			let stamp = "";
			if (located.path) {
				const rootStamp = mtimeOf(located.path);
				if (
					this.tsconfigChain === null ||
					this.tsconfigChain.root !== located.path ||
					this.tsconfigChain.rootStamp !== rootStamp
				) {
					this.tsconfigChain = {
						root: located.path,
						rootStamp,
						paths: tsConfigChain(located.path),
					};
				}
				stamp = this.tsconfigChain.paths.map(mtimeOf).join(",");
			}
			return [testDir ?? "", located.path ?? "", stamp].join("::");
		} catch {
			return null;
		}
	}

	/**
	 * Whether any directory the scan covers has changed since the last check.
	 *
	 * Two sources, because neither alone is enough:
	 *
	 * - Every directory that currently holds a project file, from the keys of
	 *   {@link mtimes} - free, since the sweep maintains that map anyway. Covers a
	 *   file appearing beside files already loaded, and a whole new subdirectory,
	 *   which bumps its existing parent.
	 * - The scan roots themselves, so a file landing in a root that holds no
	 *   loaded source is still seen.
	 *
	 * Not exhaustive, and the timer is why that is acceptable: a file created in a
	 * pre-existing *nested* directory holding no loaded source is still missed
	 * until the window elapses. Catching that exactly needs a recursive watcher.
	 * One second late is the worst case; before this it was "until something else
	 * changed".
	 */
	private scanDirsChanged(): boolean {
		if (this.inMemory) {
			return false;
		}
		const directories = new Set<string>(this.scanRoots());
		for (const filePath of this.mtimes.keys()) {
			directories.add(path.dirname(filePath));
		}
		// The project root, whether or not anything is scanned there, and the
		// directories holding the configs already found.
		//
		// This gate gets `rediscoverConfigs()` as well as the re-glob, and config
		// discovery does not follow the scan scope: a server scoped to `src` finds
		// `playwright.config.ts` at the root. Watching only scan roots and the
		// directories of loaded sources meant a config *appearing* at the root was
		// invisible for the throttle window, so the next call kept the old
		// `testIdAttribute` and `testDir` while promising results reflect the disk.
		directories.add(this.root);
		for (const candidate of this.discovery?.candidates ?? []) {
			directories.add(path.dirname(path.resolve(candidate)));
		}
		// Per directory, not a sum over the set, and only directories already known
		// count as evidence. The set *grows* on its own as the resolver pulls files
		// in on demand, so a summed stamp changed on almost every call and the
		// re-glob it is supposed to gate ran every time - measured at 5-8% slower
		// across the board on a 4,924-file repository, for a signal that was
		// reporting the project loading rather than the disk changing.
		//
		// A genuinely new directory needs no special case: creating `src/new/`
		// bumps the mtime of `src`, which is already known.
		let changed = false;
		const seen = new Set<string>();
		for (const directory of directories) {
			let stamp: number;
			try {
				stamp = fs.statSync(directory).mtimeMs;
			} catch {
				// Not there. Remembered as such rather than skipped: a scan root that
				// does not exist yet is the one case where *appearing* is the change,
				// and dropping it here meant the first call after `mkdir e2e` fell
				// back on the re-glob throttle instead of defeating it.
				seen.add(directory);
				this.scanDirMtimes.set(directory, MISSING_DIR);
				continue;
			}
			seen.add(directory);
			const previous = this.scanDirMtimes.get(directory);
			if (previous !== undefined && previous !== stamp) {
				changed = true;
			}
			this.scanDirMtimes.set(directory, stamp);
		}
		for (const directory of this.scanDirMtimes.keys()) {
			if (!seen.has(directory)) {
				this.scanDirMtimes.delete(directory);
			}
		}
		return changed;
	}

	/**
	 * The directories the scan is anchored at.
	 *
	 * For a tsconfig-backed project, its `wildcardDirectories` - TypeScript
	 * computes them for exactly this purpose and they are the only place the
	 * scan's *directories*, as opposed to its files, are written down. Cached
	 * against the tsconfig's own mtime, so the parse behind them is not repeated
	 * per call.
	 */
	private scanRoots(): string[] {
		const include = this.options.include ?? [];
		if (include.length > 0) {
			return include
				.filter((pattern) => !pattern.startsWith("!"))
				.map((pattern) =>
					path.resolve(this.root, globStaticBase(pattern) || "."),
				);
		}
		if (!this.tsconfigPath) {
			return [this.root];
		}
		const stamp = mtimeOf(this.tsconfigPath);
		if (
			this.wildcardDirs === null ||
			this.wildcardDirs.root !== this.tsconfigPath ||
			this.wildcardDirs.stamp !== stamp
		) {
			this.wildcardDirs = {
				root: this.tsconfigPath,
				stamp,
				paths: tsConfigWildcardDirectories(this.tsconfigPath),
			};
		}
		return this.wildcardDirs.paths.length > 0
			? this.wildcardDirs.paths
			: [this.root];
	}

	private rememberProjectIdentity(): void {
		this.identity = this.projectIdentity();
	}

	/**
	 * Whether a package install has happened since the last sweep.
	 *
	 * The lockfile stands in for the whole of `node_modules`: it is one file, it
	 * is rewritten by every install across npm, yarn, pnpm and bun, and the
	 * alternative — walking a dependency tree on every tool call — is not
	 * something this can afford. Missing entirely is a stable state, not a
	 * change, so a repository with no lockfile never bumps on this.
	 *
	 * The analysed root's, and the nearest ancestor's above it.
	 *
	 * "A package below the root sees the change on its own lockfile" was wrong
	 * about how workspaces work: npm, yarn and pnpm all keep one lockfile at the
	 * repository root and none in the packages. So a server rooted at
	 * `apps/web` — the normal way to run this on a monorepo — stat'ed nothing
	 * that any install ever touches, and a `pnpm install` that relinked a package
	 * left every resolver cache from before it in place, still calling first-party
	 * source an external dependency, for the rest of the session.
	 */
	private lockfileChanged(): boolean {
		let stamp = 0;
		for (const directory of this.lockfileDirectories()) {
			for (const name of LOCKFILE_NAMES) {
				try {
					stamp += fs.statSync(path.join(directory, name)).mtimeMs;
				} catch {
					// Absent: contributes nothing, and stays contributing nothing.
				}
			}
		}
		const previous = this.lockfileStamp;
		this.lockfileStamp = stamp;
		// The first sweep establishes the baseline rather than reporting a change.
		return previous !== null && previous !== stamp;
	}

	/**
	 * Where a lockfile that governs this root could live: the root itself, and
	 * the nearest ancestor holding one.
	 *
	 * Only the nearest: a monorepo has exactly one lockfile above a package, so
	 * finding the first is finding it. The walk stops there, or at the repository
	 * boundary — going past `.git` would stat a user's home directory every sweep
	 * and could only ever find a lockfile belonging to something else.
	 *
	 * Deliberately not cached, which the first version of this got wrong. A
	 * negative result is not stable: a monorepo whose lockfile does not exist
	 * when the server starts gets one on the next install, and a cache would
	 * never look again. What is left is a handful of stats that stop at the first
	 * hit, which is cheaper than being wrong for the rest of the session.
	 *
	 * Deliberately not cached. A negative result is not stable: a monorepo whose
	 * lockfile does not exist when the server starts gets one on the next
	 * install, and a cache would never look again. The walk is a handful of stats
	 * that stops at the first lockfile or at the repository boundary, so paying
	 * it per sweep is cheaper than being wrong for the rest of the session.
	 */
	private lockfileDirectories(): string[] {
		const directories = [this.root];
		let current = path.dirname(this.root);
		for (let hop = 0; hop < MAX_LOCKFILE_ANCESTORS; hop += 1) {
			const here = current;
			const hasLockfile = LOCKFILE_NAMES.some(
				(name) => mtimeOf(path.join(here, name)) !== "missing",
			);
			if (hasLockfile) {
				directories.push(here);
				break;
			}
			// The repository boundary. Walking past it would stat a user's home
			// directory on every sweep and could only ever find a lockfile that has
			// nothing to do with this project.
			if (mtimeOf(path.join(here, ".git")) !== "missing") {
				break;
			}
			const parent = path.dirname(here);
			if (parent === here) {
				break;
			}
			current = parent;
		}
		return directories;
	}

	/** Whether {@link projectIdentity} has moved since the last acquire. */
	private projectIdentityChanged(): boolean {
		const current = this.projectIdentity();
		// Unreadable now, or never read: either way there is nothing to compare,
		// and reusing the project is the answer that changes nothing.
		if (current === null) {
			return false;
		}
		if (this.identity === null || this.identity === current) {
			this.identity = current;
			return false;
		}
		this.identity = current;
		return true;
	}

	/**
	 * Wraps an already-built `Project`. Used by in-memory unit tests and by any
	 * caller that needs full control over how files were added.
	 */
	static fromProject(
		project: Project,
		options: WorkspaceOptions,
		meta?: { inMemory?: boolean; tsconfigPath?: string | null },
	): Workspace {
		const normalized = withNormalizedScope(options);
		const workspace = new Workspace(
			project,
			normalized.options,
			meta?.tsconfigPath ?? null,
			meta?.inMemory ?? true,
		);
		workspace.noteMissingScope(normalized.missing);
		return workspace;
	}

	/**
	 * A workspace over a freshly opened project. The plan is made in
	 * `./workspaceBuild`; this is only where it is handed to a constructor the
	 * plan cannot reach.
	 */
	private static create(options: WorkspaceOptions): Workspace {
		const plan = planProject(
			options,
			(probe) => new Workspace(probe, options, null, false),
		);
		const workspace = new Workspace(
			plan.project,
			options,
			plan.tsconfigPath,
			false,
			plan.discovery,
		);
		workspace.warnings.push(...plan.warnings);
		return workspace;
	}

	/**
	 * Records scope directories that are not on disk.
	 *
	 * A `--src-dir` naming a directory that does not exist expands to a glob that
	 * matches nothing, and the analysis then reports an empty project as if the
	 * repository were empty. The stat has already happened inside
	 * {@link withNormalizedScope}; this is only where its verdict is said out
	 * loud. A *glob* matching nothing is not reported here — that is
	 * indistinguishable from a legitimately empty directory, and `scope-empty`
	 * covers it from the evidence side.
	 */
	private noteMissingScope(missing: string[]): void {
		// Replaced, not appended. The normalized include pattern is part of the
		// cache key, so a `--src-dir` that did not exist on the first call and was
		// created before the second reuses the same workspace with `missing` now
		// empty - and an early return left the old diagnostic in place, still
		// telling the caller nothing from that directory is in scope while the
		// rescan was already loading its files. Same defect as the config notes
		// that outlived the config: a warning has to be able to stop being true.
		const kept = this.warnings.filter(
			(diagnostic) => diagnostic.code !== "scope-dir-missing",
		);
		for (const directory of missing) {
			kept.push(
				warn(
					"scope-dir-missing",
					`The analysed directory "${directory}" does not exist under ${toPosix(this.root)}; nothing from it is in scope.`,
					undefined,
					{ path: directory },
				),
			);
		}
		const merged = dedupeDiagnostics(kept);
		this.warnings.length = 0;
		this.warnings.push(...merged);
	}

	/**
	 * Sweeps mtimes, refreshes changed files, drops deleted ones and picks up new
	 * ones. Cheap enough to run on every tool call.
	 *
	 * The freshness contract is unchanged by anything here: every file the
	 * project holds is stat'ed on every call, and the repository is re-scanned
	 * for new files on the `staleAfterMs` cadence. Only the bookkeeping is
	 * cheaper — one enumeration of the project instead of two, and one walk of
	 * the tsconfig's file set instead of two (see {@link rescan}).
	 */
	revalidate(): RevalidateResult {
		const result: RevalidateResult = { changed: [], added: [], removed: [] };
		if (this.inMemory) {
			return result;
		}

		// The set the re-glob below diffs against, collected by the sweep that is
		// already walking every file rather than by a second enumeration.
		const before = new Set<string>();
		for (const sourceFile of [...this.project.getSourceFiles()]) {
			const filePath = sourceFile.getFilePath();
			before.add(filePath);
			const absolute = toPosix(filePath);
			if (absolute.includes("/node_modules/")) {
				continue;
			}
			let stamp: number | null = null;
			try {
				stamp = fs.statSync(absolute).mtimeMs;
			} catch {
				stamp = null;
			}
			if (stamp === null) {
				this.project.removeSourceFile(sourceFile);
				this.mtimes.delete(absolute);
				before.delete(filePath);
				result.removed.push(this.rel(absolute));
				continue;
			}
			const previous = this.mtimes.get(absolute);
			if (previous === undefined) {
				// First sweep over a file the resolver added on demand *after*
				// construction — a `.js` module, an alias target, anything outside a
				// narrowed scope. Its text was read when it was added, and an edit
				// since then leaves no trace here: recording the new stamp without
				// looking would freeze the pre-edit AST in place for good, because
				// every later sweep then sees an unchanged mtime. Refreshing compares
				// the text, so an untouched file reports nothing and costs one read,
				// once, the first time the file is seen.
				const refreshed = sourceFile.refreshFromFileSystemSync();
				if (refreshed === FileSystemRefreshResult.Deleted) {
					// `refreshFromFileSystemSync` has already forgotten the file.
					this.mtimes.delete(absolute);
					before.delete(filePath);
					result.removed.push(this.rel(absolute));
					continue;
				}
				if (refreshed === FileSystemRefreshResult.Updated) {
					result.changed.push(this.rel(absolute));
				}
			} else if (previous !== stamp) {
				sourceFile.refreshFromFileSystemSync();
				result.changed.push(this.rel(absolute));
			}
			this.mtimes.set(absolute, stamp);
		}

		const now = Date.now();
		const rescanned: SourceFile[] = [];
		// The timer is the backstop, not the trigger. A file the agent has just
		// *created* is invisible to the sweep above - that only visits files the
		// project already holds - so throttling the re-glob throttled the one thing
		// it is needed for, and the server's own promise that "results reflect the
		// files on disk at the moment of the call" was false for the commonest
		// workflow there is: write a component, then ask about it.
		//
		// A changed directory is the cheap exact signal. Hundreds of stats against
		// the ~226 ms the re-glob costs on a 4,924-file repository.
		//
		// Evaluated before the `||`, never short-circuited by it: the call is what
		// refreshes the baseline, so letting the timer skip it would leave the
		// stamp describing whatever the tree looked like two calls ago and the
		// *next* comparison would be against the wrong snapshot.
		const dirsChanged = this.scanDirsChanged();
		if (now - this.lastGlobAt >= this.staleAfterMs || dirsChanged) {
			this.lastGlobAt = now;
			try {
				for (const sourceFile of this.rescan()) {
					if (!before.has(sourceFile.getFilePath())) {
						rescanned.push(sourceFile);
						result.added.push(this.rel(sourceFile.getFilePath()));
					}
				}
			} catch {
				// A glob that matches nothing is not an error.
			}
			this.rediscoverConfigs();
		}

		// A newly created Playwright config changes which file the analysis should
		// be reading, and the candidate list is the one cache an epoch bump does
		// not clear. Adding `playwright.config.ts` to a repository that had none
		// must not require a server restart. This covers the config that is *in*
		// the analysed scope, including its deletion, which the mtime sweep sees
		// immediately rather than at the next re-glob.
		if (
			result.added.some(isPlaywrightConfigPath) ||
			result.removed.some(isPlaywrightConfigPath)
		) {
			this.discovery = null;
			this.playwrightInfo = null;
		}

		// An install changes what the resolver would answer without touching a
		// single analysed file, and every one of those answers is memoized per
		// epoch: which package resolves to which entry, which link leads where,
		// which specifier is external. Nothing in the mtime sweep can see it —
		// `node_modules` is skipped by the sweep, deliberately — so a linked
		// workspace package added mid-session stayed external for as long as the
		// process ran. One stat on the lockfile is the cheapest thing that notices.
		const installChanged = this.lockfileChanged();

		if (
			installChanged ||
			result.changed.length > 0 ||
			result.added.length > 0 ||
			result.removed.length > 0
		) {
			this.recordMtimes();
			this.bumpEpoch();
			// The rescan is the one thing here that can grow the project, so it is
			// what gets rolled back when the growth breaks the cap — and what makes
			// this workspace's scope unviable, so it also leaves the cache.
			this.enforceMaxFiles(rescanned, true);
		}
		// The sweep and the re-glob are the two things that change the project's
		// file set behind the running total; from here it is unknown again, and
		// the next admission recounts once before resuming.
		this.parsedTotal = UNKNOWN_TOTAL;
		return result;
	}
}
