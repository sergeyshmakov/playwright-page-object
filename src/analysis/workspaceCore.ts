import * as fs from "node:fs";
import {
	FileSystemRefreshResult,
	type Project,
	type SourceFile,
} from "ts-morph";
import { isPlaywrightConfigPath } from "./config/configDiscovery";
import { dedupeDiagnostics, warn } from "./diagnostics";
import { toPosix } from "./util/paths";
import { planProject } from "./workspaceBuild";
import { DEFAULT_STALE_AFTER_MS, UNKNOWN_TOTAL } from "./workspaceFiles";
import type { RevalidateResult, WorkspaceOptions } from "./workspaceOptions";
import { withNormalizedScope } from "./workspaceScope";
import { WorkspaceStamps } from "./workspaceStamps";

/**
 * Owns the ts-morph `Project` for one analysed root.
 *
 * Invalidation is an mtime sweep per call rather than `fs.watch`: it is
 * stateless, survives branch switches and bulk checkouts, needs no debounce,
 * and behaves on network or virtualised filesystems where watch events are
 * unreliable.
 */
export class Workspace extends WorkspaceStamps {
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
