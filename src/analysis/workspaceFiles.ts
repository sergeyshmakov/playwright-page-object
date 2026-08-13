import * as fs from "node:fs";
import * as path from "node:path";
import type { Node, Project, SourceFile } from "ts-morph";
import {
	type ConfigDiscovery,
	discoverPlaywrightConfigs,
} from "./config/configDiscovery";
import { readPlaywrightConfig } from "./config/playwrightConfig";
import {
	defaultExcludeGlobs,
	defaultIncludeGlobs,
	tsConfigFileNames,
} from "./config/tsconfig";
import { AnalysisLimitError, dedupeDiagnostics, info } from "./diagnostics";
import { attributeVerdict, censusFromText } from "./tsx/attributeCensus";
import type {
	Diagnostic,
	DiagnosticCode,
	PlaywrightConfigInfo,
	SourceLoc,
	TestIdAttributeSource,
} from "./types";
import { registerFileAdmission } from "./util/fileBudget";
import { toPosix, toPosixRelative } from "./util/paths";
import { lineAndColumnAt } from "./util/position";
import { clearResolutionCaches } from "./util/resolve";
import { registerWorkspaceRoot } from "./util/workspaceRoot";
import { DEFAULT_MAX_FILES } from "./workspaceBuild";
import type { WorkspaceOptions } from "./workspaceOptions";
import {
	absoluteGlob,
	countsAgainstCap,
	isAnalysable,
	isJsxFile,
	normalizeRoot,
	scopeExcludeGlobs,
} from "./workspaceScope";

/**
 * The files a workspace holds, and everything derived from them.
 *
 * The base of the class, not a collaborator of it, because one question runs
 * through all of it: the ts-morph `Project` is the state, and the mtime map,
 * the epoch-keyed memo cache, the `maxFiles` accounting and the config readers
 * are each a view of that same state that has to move with it. Composition
 * would mean handing every one of them a reference back to the project and to
 * each other.
 *
 * What is *not* here is anything about whether this workspace is still the
 * right one to be asking - see `./workspaceCore`.
 */

export const DEFAULT_TEST_ID_ATTRIBUTE = "data-testid";

/**
 * Parsed-file count above which a scan reports what it cost.
 *
 * Raising the ceiling removed a hard stop that was also, accidentally, the only
 * thing telling anyone the scan was large. This keeps the information without
 * the refusal: past this many files the workspace says how many it parsed and
 * how to bound it, and the call still answers.
 */
const LARGE_SCAN_FILES = 3000;

export const DEFAULT_STALE_AFTER_MS = 1000;

/** Sentinel for "the running file total has to be recounted". */
export const UNKNOWN_TOTAL = -1;

/**
 * Environment warnings ship on every payload, so the list has to stay readable.
 * Eight is more than any single misconfiguration produces; a repository that
 * trips more than that has one root cause and the ranking puts it first.
 */
const MAX_ENVIRONMENT_WARNINGS = 8;

/**
 * Ordering of environment warnings: what makes the answer wrong, before what
 * makes it incomplete, before why.
 */
function environmentRank(code: DiagnosticCode): number {
	switch (code) {
		case "attribute-mismatch":
		case "attribute-no-evidence":
		case "testid-attribute-unresolved":
		case "testid-attribute-conflict":
		case "testid-attribute-inherited":
		case "testid-attribute-sibling":
		case "testid-attribute-maybe-spread":
		case "testid-attribute-project-override":
			return 0;
		case "scope-empty":
		case "scope-dir-missing":
			return 1;
		case "playwright-config-not-found":
		case "playwright-config-ambiguous":
		case "config-shape-unrecognized":
		case "config-merge-unresolved":
		case "testdir-unresolved":
		case "no-tsconfig":
		case "tsconfig-not-found":
			return 2;
		default:
			return 3;
	}
}

interface MemoEntry {
	signature: string;
	value: unknown;
}

export class WorkspaceFiles {
	readonly project: Project;
	readonly root: string;
	readonly options: WorkspaceOptions;
	readonly tsconfigPath: string | null;
	readonly warnings: Diagnostic[] = [];

	protected readonly inMemory: boolean;
	protected readonly mtimes = new Map<string, number>();
	private readonly memoCache = new Map<string, MemoEntry>();
	private epoch = 0;
	/**
	 * Bumped whenever the resolver pulls an *analysable* file into the project
	 * mid-call. See {@link admitResolvedFile} for why that cannot be an epoch
	 * bump, and {@link memo} for why a derived value still has to notice.
	 */
	private fileSetVersion = 0;
	/**
	 * Running count of every file the project holds, or {@link UNKNOWN_TOTAL}.
	 * Maintained by {@link admitResolvedFile}, which is the only thing that reads
	 * it, and invalidated by anything that changes the set behind its back.
	 */
	protected parsedTotal = UNKNOWN_TOTAL;
	protected lastGlobAt = 0;
	/**
	 * Per-call freshness policy; the latest caller's value wins. See
	 * {@link WorkspacePool.acquire}.
	 */
	protected staleAfterMs: number;
	/**
	 * Drops this workspace from whatever is holding it, if anything is. Armed by
	 * {@link WorkspacePool.acquire}; called by {@link enforceMaxFiles}, which is
	 * the one place a workspace decides it must not be handed out again.
	 */
	protected evictSelf: (() => void) | null = null;
	/** So the large-scan note is stated once, not on every revalidation sweep. */
	private largeScanNoted = false;
	protected playwrightInfo: {
		epoch: number;
		value: PlaywrightConfigInfo;
	} | null = null;
	/**
	 * Ranked Playwright config paths. Deliberately *not* epoch-scoped: an edit to
	 * a source file changes what the configs say, never which files exist, and
	 * re-globbing the repository on every epoch bump would put a filesystem walk
	 * on the hot path. {@link revalidate} refreshes it on the same throttled
	 * cadence as the source re-glob (see {@link rediscoverConfigs}), and clears
	 * it outright when a config-shaped file appears in or leaves the scan.
	 */
	protected discovery: ConfigDiscovery | null = null;
	private fileList: { epoch: number; value: SourceFile[] } | null = null;

	protected constructor(
		project: Project,
		options: WorkspaceOptions,
		tsconfigPath: string | null,
		inMemory: boolean,
		discovery: ConfigDiscovery | null = null,
	) {
		this.project = project;
		this.options = options;
		this.root = normalizeRoot(options.projectRoot);
		this.tsconfigPath = tsconfigPath;
		this.inMemory = inMemory;
		this.discovery = discovery;
		this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
		// The resolver classifies files by real path, and it needs the analysed
		// root to tell a linked workspace package apart from an installed one.
		registerWorkspaceRoot(project, this.root);
		this.recordMtimes();
		this.enforceMaxFiles();
		// Last, and only once nothing above has thrown. The resolver adds files
		// straight to the `Project`, and this is how they reach the same cap as
		// everything else — but the gate chain is keyed by the `Project`, not by
		// this workspace, so a gate registered before a failed construction would
		// outlive its owner. The next caller to reuse that project, typically with
		// the larger `maxFiles` the failure asked for, would then have every
		// on-demand addition refused by a cap belonging to nobody.
		registerFileAdmission(project, (added) => {
			this.admitResolvedFile(added);
		});
	}

	get currentEpoch(): number {
		return this.epoch;
	}

	rel(absolutePath: string): string {
		return toPosixRelative(this.root, absolutePath);
	}

	abs(relativePath: string): string {
		return path.resolve(this.root, relativePath);
	}

	/** Location of a node, with a workspace-relative posix `file`. */
	loc(node: Node): SourceLoc {
		const sourceFile = node.getSourceFile();
		const position = lineAndColumnAt(sourceFile, node.getStart());
		return {
			file: this.rel(sourceFile.getFilePath()),
			line: position.line,
			column: position.column,
		};
	}

	fileLoc(sourceFile: SourceFile, line = 1): SourceLoc {
		return { file: this.rel(sourceFile.getFilePath()), line };
	}

	/**
	 * Source files that belong to the analysed project: inside the root, not in
	 * `node_modules` or a build output directory, and not a declaration file.
	 */
	sourceFiles(): SourceFile[] {
		if (this.fileList && this.fileList.epoch === this.epoch) {
			return this.fileList.value;
		}
		const include = this.options.include ?? [];
		const exclude = this.options.exclude ?? [];
		const files: SourceFile[] = [];
		for (const sourceFile of this.project.getSourceFiles()) {
			const absolute = sourceFile.getFilePath();
			if (isAnalysable(absolute, this.rel(absolute), include, exclude)) {
				files.push(sourceFile);
			}
		}
		files.sort((a, b) => (a.getFilePath() < b.getFilePath() ? -1 : 1));
		this.fileList = { epoch: this.epoch, value: files };
		return files;
	}

	/**
	 * Whether one file would appear in {@link sourceFiles}.
	 *
	 * The list is memoized per epoch and the resolver adds files to the `Project`
	 * without bumping it, so a file pulled in mid-analysis is invisible to
	 * `sourceFiles()` until something else invalidates it. A caller that finds
	 * such a file has to be able to ask the same membership question the list
	 * asks, rather than re-deriving the predicate and drifting from it.
	 *
	 * The mtime sweep in {@link revalidate} skips it as well: it walks files the
	 * project already holds, and a file the resolver pulls in only exists there
	 * from the moment it is added. Both gaps are why {@link fileSetVersion} is a
	 * separate counter rather than an epoch bump.
	 */
	analysable(sourceFile: SourceFile): boolean {
		const absolute = sourceFile.getFilePath();
		return isAnalysable(
			absolute,
			this.rel(absolute),
			this.options.include ?? [],
			this.options.exclude ?? [],
		);
	}

	tsFiles(): SourceFile[] {
		return this.sourceFiles().filter((file) => !isJsxFile(file.getFilePath()));
	}

	jsxFiles(): SourceFile[] {
		return this.sourceFiles().filter((file) => isJsxFile(file.getFilePath()));
	}

	/** Ranked Playwright config candidates, discovered once and cached. */
	configDiscovery(): ConfigDiscovery {
		this.discovery ??= discoverPlaywrightConfigs(this.project, this.root);
		return this.discovery;
	}

	/** Memoized `playwright.config.*` read, refreshed once per epoch. */
	playwright(): PlaywrightConfigInfo {
		if (this.playwrightInfo && this.playwrightInfo.epoch === this.epoch) {
			return this.playwrightInfo.value;
		}
		const value = readPlaywrightConfig(
			this,
			this.options.playwrightConfig,
			this.configDiscovery(),
		);
		this.playwrightInfo = { epoch: this.epoch, value };
		return value;
	}

	/**
	 * Everything wrong with the *environment* this analysis ran in, ordered by
	 * how badly it invalidates the result.
	 *
	 * Every payload seeds its warnings from here. Before this existed only
	 * `discoverPageObjects` carried `ws.warnings`, so a caller of
	 * `get_testid_tree` or `map_coverage` on a misconfigured repository received
	 * an empty tree and a perfect coverage score with nothing at all to indicate
	 * the attribute had been read off the wrong file.
	 *
	 * `effectiveAttribute` is the attribute the caller actually used: per-call
	 * overrides bypass `testIdAttribute()`, and checking the workspace default
	 * against sources scanned with a different name would report a mismatch that
	 * is not there — or miss the one that is.
	 */
	environmentWarnings(effectiveAttribute?: string): Diagnostic[] {
		const resolved = this.testIdAttribute();
		const attribute = effectiveAttribute ?? resolved.attribute;
		const source =
			effectiveAttribute && effectiveAttribute !== resolved.attribute
				? "param"
				: resolved.source;
		return this.memo(`env-warnings::${attribute}`, [], () => {
			const collected: Diagnostic[] = [];
			const verdict = attributeVerdict(censusFromText(this, attribute), source);
			if (verdict) {
				collected.push(verdict);
			}
			// Composed per call, not accumulated. Every note, unconditionally — the
			// old gate dropped everything a *missing* config had to say, including
			// "several configs exist" and "the one you named is not there", on the
			// theory that no config is not news.
			//
			// What it must not do is *keep* them. These notes used to be merged into
			// the sticky list, and `dedupeDiagnostics` collapses repeats but never
			// retires one: a config the user then fixed went on warning for the life
			// of the process, with `environmentHint` telling an agent to restart a
			// server that had already picked the fix up. The config read is memoized
			// per epoch and an edit bumps the epoch, so reading `notes` here is both
			// current and free.
			collected.push(...this.playwright().notes);
			collected.push(...this.warnings);
			return dedupeDiagnostics(collected)
				.sort(
					(left, right) =>
						environmentRank(left.code) - environmentRank(right.code),
				)
				.slice(0, MAX_ENVIRONMENT_WARNINGS);
		});
	}

	/**
	 * Resolved test-id attribute. An explicit option beats the Playwright config,
	 * which beats Playwright's own `data-testid` default.
	 */
	testIdAttribute(): { attribute: string; source: TestIdAttributeSource } {
		if (this.options.attribute) {
			return { attribute: this.options.attribute, source: "param" };
		}
		const configured = this.playwright().testIdAttribute;
		if (configured) {
			return { attribute: configured, source: "playwright-config" };
		}
		return { attribute: DEFAULT_TEST_ID_ATTRIBUTE, source: "default" };
	}

	/**
	 * Caches a derived value against the mtimes of the files it was computed
	 * from, so an edit elsewhere in the repo does not throw the whole cache away.
	 *
	 * The epoch is not the whole story for a value derived from `sourceFiles()`.
	 * The resolver adds files to the project mid-walk without bumping it (see
	 * {@link admitResolvedFile}), so a result computed before such an addition
	 * describes a smaller repository than the one now loaded. Today that heals on
	 * the next call, because the next call recomputes from scratch; a cache keyed
	 * on the epoch alone would freeze the incomplete answer for the session.
	 *
	 * {@link fileSetVersion} is in the signature for exactly that. It is read
	 * *before* `compute` runs, so a call that itself pulls new files in stores a
	 * signature that is already stale and is recomputed once more — which is the
	 * old self-healing behaviour, and it converges as soon as a call adds nothing.
	 */
	memo<T>(key: string, fileDeps: string[], compute: () => T): T {
		const signature =
			fileDeps.length === 0
				? `epoch:${this.epoch}/files:${this.fileSetVersion}`
				: fileDeps
						.map((file) => {
							const absolute = toPosix(this.abs(file));
							const stamp = this.mtimes.get(absolute);
							return `${absolute}@${stamp ?? `e${this.epoch}`}`;
						})
						.join("|");
		const hit = this.memoCache.get(key);
		if (hit && hit.signature === signature) {
			return hit.value as T;
		}
		const value = compute();
		this.memoCache.set(key, { signature, value });
		return value;
	}

	/** Test hook: forces every epoch-scoped cache to miss. */
	bumpEpoch(): void {
		this.epoch += 1;
		this.fileList = null;
		this.playwrightInfo = null;
		// The resolver's probe caches are statements about files as they were:
		// which package resolves to which entry, which link leads where, which
		// `SourceFile` a specifier lands on. An epoch bump is the event that says
		// they are no longer what they were.
		clearResolutionCaches(this.project);
	}

	/**
	 * Re-runs the scan that populated the project so newly created files appear.
	 *
	 * A tsconfig-backed project has to be rescanned through that same tsconfig:
	 * falling back to `defaultIncludeGlobs` would drag in sibling packages and
	 * the files the tsconfig deliberately excludes, silently widening every
	 * later result and eating into `maxFiles`.
	 *
	 * That branch reads the config's file set itself rather than going through
	 * `addSourceFilesFromTsConfig`, which walks the repository twice for one
	 * answer: `TsConfigResolver` re-reads and re-parses the tsconfig — the walk —
	 * and then calls `addSourceFileAtPath` for every name it found, path
	 * normalisation and all, when on a warm call every single one of them is
	 * already loaded. Measured on a 4,924-file repository: 431 ms for the
	 * ts-morph call against 210 ms for the walk plus 16 ms to check all 4,929
	 * names against the project. The `getSourceFile` pre-check is what makes the
	 * difference, and the answer is identical — only genuinely new files are
	 * added, which is the only thing the caller reads from the return value.
	 */
	protected rescan(): SourceFile[] {
		const include = this.options.include ?? [];
		if (include.length === 0 && this.tsconfigPath) {
			// Not verified against the filesystem: a name that has since vanished
			// simply adds nothing below, so the stat the counting path needs would
			// be several thousand syscalls spent to reach the same place.
			const fileNames = tsConfigFileNames(this.tsconfigPath, {
				verifyExists: false,
			});
			if (!fileNames) {
				return this.project.addSourceFilesFromTsConfig(this.tsconfigPath);
			}
			const added: SourceFile[] = [];
			for (const fileName of fileNames) {
				if (this.project.getSourceFile(fileName)) {
					continue;
				}
				const file = this.project.addSourceFileAtPathIfExists(fileName);
				if (file) {
					added.push(file);
				}
			}
			return added;
		}
		const globs =
			include.length > 0
				? include.map((glob) => absoluteGlob(this.root, glob))
				: defaultIncludeGlobs(this.root);
		return this.project.addSourceFilesAtPaths([
			...globs,
			...defaultExcludeGlobs(this.root),
			...scopeExcludeGlobs(this.root, this.options.exclude),
		]);
	}

	/**
	 * Re-runs config discovery on the same cadence as the source re-glob.
	 *
	 * A Playwright config usually lives outside the analysed scope — always, for
	 * a tsconfig-backed or `--src-dir`-narrowed workspace — so a config created
	 * after startup never reaches `rescan()`'s `added` list, and the "a
	 * config-shaped file appeared" check below could not see it. The cached
	 * candidate list then outlived the process, and the new config's
	 * `testIdAttribute` stayed invisible until a restart.
	 *
	 * One extra `globSync` per throttle window, alongside the source walk that
	 * has just run — not one per call — and only when a list is cached at all.
	 */
	protected rediscoverConfigs(): void {
		const cached = this.discovery;
		if (!cached) {
			return;
		}
		const found = discoverPlaywrightConfigs(this.project, this.root);
		if (
			// Not just the list: whether the list is *complete* is part of what the
			// tool metadata reports, and a change beyond the cap moves only that.
			found.truncated === cached.truncated &&
			found.candidates.length === cached.candidates.length &&
			found.candidates.every(
				(candidate, index) => candidate === cached.candidates[index],
			)
		) {
			return;
		}
		this.discovery = found;
		// Which config is read decides the attribute, which decides every answer:
		// the derived caches have to go with it.
		this.bumpEpoch();
	}

	protected recordMtimes(): void {
		if (this.inMemory) {
			return;
		}
		for (const sourceFile of this.project.getSourceFiles()) {
			const absolute = toPosix(sourceFile.getFilePath());
			if (absolute.includes("/node_modules/")) {
				continue;
			}
			try {
				this.mtimes.set(absolute, fs.statSync(absolute).mtimeMs);
			} catch {
				this.mtimes.delete(absolute);
			}
		}
	}

	/**
	 * The one place the `maxFiles` cap is applied, whatever the files came from.
	 *
	 * Semantics, deliberately uniform across the constructor, the per-call
	 * rescan and the resolver's on-demand loads: **the project never holds more
	 * parsed source files than `maxFiles`** — see {@link countsAgainstCap} for
	 * what that counts, and note that it is *not* the analysed scope.
	 *
	 * An addition that would break the invariant is
	 * rolled back, the workspace leaves the LRU, and `AnalysisLimitError` (wired
	 * to `max_files_exceeded`) is raised. The rolled-back files are still on
	 * disk, so the very next call re-detects the same violation and raises again
	 * — retrying can no longer walk past the cap, which is what happened while
	 * the check ran *after* the mutation and only when something had changed.
	 *
	 * Rollback rather than "leave it oversized and keep throwing" because an
	 * over-cap project is precisely the memory and parse cost the cap exists to
	 * refuse. `evictOnFailure` is for the case where the workspace's own scan
	 * set outgrew the cap: its scope is no longer viable, so dropping it from
	 * the LRU lets the next `acquire` rebuild and refuse an oversized tsconfig
	 * in {@link precheckMaxFiles}, before any source is parsed. A single
	 * out-of-scope import is not that — the scan set is still fine, and
	 * rebuilding the whole project on every call would only re-parse it to fail
	 * in the same place.
	 */
	/**
	 * Reports a large scan once, without refusing it.
	 *
	 * Raising the ceiling removed a hard stop that was also, accidentally, the
	 * only thing that ever told anyone the scan was big. The number is worth
	 * having — it is most of the server's memory and all of its cold start — so
	 * it is stated as an `info` the moment the project is known to be large, and
	 * the call proceeds.
	 *
	 * Once per workspace: `enforceMaxFiles` runs on every revalidation sweep, and
	 * a warning repeated every call would be exactly the noise the session ledger
	 * exists to remove.
	 */
	private noteLargeScan(count: number, limit: number): void {
		if (this.largeScanNoted || count < LARGE_SCAN_FILES) {
			return;
		}
		this.largeScanNoted = true;
		this.warnings.push(
			info(
				"large-scan",
				`This analysis parses ${count} source file(s) (cap ${limit}), which is most of the server's memory and all of its cold start. Narrow it with --src-dir <dir> if the scope is wider than you meant, or lower --max-files to make an oversized scope fail fast instead of running.`,
				undefined,
				{ files: count, limit },
			),
		);
	}

	protected enforceMaxFiles(
		rollback: readonly SourceFile[] = [],
		evictOnFailure = false,
	): void {
		const limit = this.options.maxFiles ?? DEFAULT_MAX_FILES;
		const count = this.parsedCount();
		if (count <= limit) {
			this.noteLargeScan(count, limit);
			return;
		}
		for (const sourceFile of rollback) {
			this.mtimes.delete(toPosix(sourceFile.getFilePath()));
			this.project.removeSourceFile(sourceFile);
		}
		this.fileList = null;
		this.parsedTotal = UNKNOWN_TOTAL;
		// Those files are still on disk. Without this the next sweep inside the
		// throttle window would skip the re-glob, see nothing added and quietly
		// analyse the truncated project it was just left with.
		this.lastGlobAt = 0;
		if (evictOnFailure) {
			this.evictSelf?.();
			// Once, and only once: a second failure has nothing left to evict.
			this.evictSelf = null;
		}
		throw new AnalysisLimitError(limit, count);
	}

	/**
	 * Cap gate for a file that joined the project outside the workspace's own
	 * scan: an on-demand resolver load, or a Playwright config read.
	 *
	 * The cheap raw count comes first: the counted set is a subset of the
	 * project's files, so nothing can be over the cap while the raw count is
	 * not, and this runs on every on-demand load.
	 *
	 * A file that survives the cap and belongs to the analysed scope invalidates
	 * the memoized file list. Without that, a module the resolver pulled in
	 * mid-call stayed invisible to `sourceFiles()` not just for the rest of that
	 * call but for the rest of the session: the next `revalidate()` finds its
	 * mtime already recorded, reports no change, and never bumps the epoch that
	 * would have rebuilt the list. Only the list is dropped, not the epoch — an
	 * epoch bump would throw away the config read and every other per-epoch memo
	 * on every one of the hundreds of resolutions a single walk performs.
	 *
	 * The raw count is kept as a running total rather than re-derived. This runs
	 * once per on-demand load and `getSourceFiles()` builds a fresh array of
	 * every file in the project each time it is asked, so a walk that pulls in a
	 * thousand modules was quadratic in the size of the project. Every path that
	 * can change the set behind the total resets it to {@link UNKNOWN_TOTAL},
	 * and the next admission recounts — the total is an optimisation, the cap is
	 * still a guarantee.
	 *
	 * {@link fileSetVersion} goes up with it. Dropping the list is enough for a
	 * caller that re-derives everything from scratch, but a *memoized* result
	 * computed from the old list now describes a repository that no longer
	 * exists, and the epoch — the only thing such a cache could otherwise key
	 * on — has deliberately not moved. The counter is the narrow invalidation the
	 * epoch is too broad to be.
	 */
	private admitResolvedFile(added: SourceFile): void {
		const limit = this.options.maxFiles ?? DEFAULT_MAX_FILES;
		// The same set the cap counts, which the raw project length is not: it
		// includes declaration files and `node_modules`, both of which
		// `countsAgainstCap` drops. Two effects, and the second is the reason this
		// is a bug rather than a rounding difference. Once enough `.d.ts` files
		// push the raw number past the limit, *every* admission falls into
		// `enforceMaxFiles` and pays for a full project walk — reinstating the
		// quadratic cost the running total exists to remove, permanently, on
		// exactly the large repositories it was written for. And `large-scan`
		// quotes this number against `cap ${limit}`, so the two halves of that
		// sentence were counting different things.
		const absolute = added.getFilePath();
		if (this.parsedTotal === UNKNOWN_TOTAL) {
			// `added` is already in the project, so the recount includes it.
			this.parsedTotal = this.parsedCount();
		} else if (countsAgainstCap(absolute, this.rel(absolute))) {
			this.parsedTotal += 1;
		}
		if (this.parsedTotal > limit) {
			this.enforceMaxFiles([added]);
		} else {
			// A narrowly scoped workspace can still cross the large-scan threshold
			// through what the resolver drags in, and `enforceMaxFiles` — the only
			// other caller — runs on the scan, not on these admissions. Without this
			// the note never fires for exactly the scope that grew unexpectedly.
			this.noteLargeScan(this.parsedTotal, limit);
		}
		if (this.analysable(added)) {
			this.fileList = null;
			this.fileSetVersion += 1;
		}
	}

	/**
	 * Live count of what the cap governs.
	 *
	 * Counted fresh rather than through `sourceFiles()`: that list is memoized
	 * per epoch, and files added since — by the resolver, or by the rescan being
	 * checked right now — are exactly the ones the cap has to see.
	 */
	private parsedCount(): number {
		let count = 0;
		for (const sourceFile of this.project.getSourceFiles()) {
			const absolute = sourceFile.getFilePath();
			if (countsAgainstCap(absolute, this.rel(absolute))) {
				count += 1;
			}
		}
		return count;
	}
}
