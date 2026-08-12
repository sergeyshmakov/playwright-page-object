import * as fs from "node:fs";
import * as path from "node:path";
import {
	FileSystemRefreshResult,
	type Node,
	Project,
	type SourceFile,
} from "ts-morph";
import {
	type ConfigDiscovery,
	discoverPlaywrightConfigs,
	isPlaywrightConfigPath,
} from "./config/configDiscovery";
import { readPlaywrightConfig } from "./config/playwrightConfig";
import {
	defaultExcludeGlobs,
	defaultIncludeGlobs,
	locateTsConfig,
	SCAN_GLOB,
	synthesizedCompilerOptions,
	tsConfigChain,
	tsConfigFileNames,
	tsConfigWildcardDirectories,
} from "./config/tsconfig";
import {
	AnalysisLimitError,
	dedupeDiagnostics,
	info,
	warn,
} from "./diagnostics";
import { attributeVerdict, censusFromText } from "./tsx/attributeCensus";
import type {
	Diagnostic,
	DiagnosticCode,
	PlaywrightConfigInfo,
	SourceLoc,
	TestIdAttributeSource,
} from "./types";
import { registerFileAdmission } from "./util/fileBudget";
import {
	foldPath,
	globStaticBase,
	isDeclarationFile,
	isGlobPattern,
	isIgnoredPath,
	isOutsideRoot,
	matchesAnyGlob,
	toPosix,
	toPosixRelative,
} from "./util/paths";
import { lineAndColumnAt } from "./util/position";
import { clearResolutionCaches } from "./util/resolve";
import { registerWorkspaceRoot } from "./util/workspaceRoot";

export const DEFAULT_TEST_ID_ATTRIBUTE = "data-testid";
/**
 * Files the scan will parse before refusing. Matches the documented
 * `--max-files` default in `src/cli.ts` and the docs.
 *
 * 8,000, raised from 2,000. The old default refused every call on the repos
 * this exists for — three independent audits of a 4,924-file application had to
 * pass `--max-files` before anything worked at all — and because it is a
 * *startup* flag, the agent holding the error cannot act on it. It has to stop
 * and ask a human to edit an MCP client config, which is the one failure an
 * agent-facing tool must not have.
 *
 * The failure is asymmetric. Set too low, the product does not work and only a
 * human can unblock it. Set too high, a scan uses memory the user can see and
 * that {@link IDLE_EVICT_AFTER_MS} hands back after ten idle minutes. Measured
 * at roughly 0.13 MB of RSS per parsed file, 8,000 is about a gigabyte at the
 * ceiling and covers both scopes those audits used: a large application and the
 * monorepo root the `ui-scope-incomplete` warning tells you to re-root at
 * (6,253 files — which the old cap, and even 6,000, would have refused after
 * recommending it).
 *
 * It is still a cap, not a licence: pointing the server at a home directory
 * should fail rather than swallow the machine.
 */
const DEFAULT_MAX_FILES = 8000;

/**
 * Parsed-file count above which a scan reports what it cost.
 *
 * Raising the ceiling removed a hard stop that was also, accidentally, the only
 * thing telling anyone the scan was large. This keeps the information without
 * the refusal: past this many files the workspace says how many it parsed and
 * how to bound it, and the call still answers.
 */
const LARGE_SCAN_FILES = 3000;
const DEFAULT_STALE_AFTER_MS = 1000;
const LRU_SIZE = 2;

/**
 * How long a cached workspace survives with nobody asking it anything.
 *
 * The LRU bounds how *many* workspaces are held, never how long. A stdio server
 * is one process holding one workspace for as long as the editor is open, so a
 * ts-morph `Project` over a large monorepo — measured at 645 MB on a 4,924-file
 * app and 867 MB at its repository root — stayed resident all day whether or
 * not another call ever came.
 *
 * Ten minutes of silence is an agent that has moved on. The cost of being wrong
 * is one cold rebuild (~2.3 s) on the next call; the cost of not doing it is
 * half a gigabyte held against a developer's machine indefinitely.
 *
 * It matches {@link HANDLE_TTL_MS} in the MCP layer deliberately: both are idle
 * timers over the same activity, so an idle session releases its workspace and
 * its coverage handles together instead of one outliving the other. Eviction is
 * safe for a live handle in any case — the store compares workspace identity
 * and returns a recoverable `expired_handle`.
 */
const IDLE_EVICT_AFTER_MS = 10 * 60_000;
/** Sentinel for "the running file total has to be recounted". */
const UNKNOWN_TOTAL = -1;
/**
 * Environment warnings ship on every payload, so the list has to stay readable.
 * Eight is more than any single misconfiguration produces; a repository that
 * trips more than that has one root cause and the ranking puts it first.
 */
const MAX_ENVIRONMENT_WARNINGS = 8;

/** Every lockfile the four package managers write, stat'ed as one signal. */
const LOCKFILE_NAMES = [
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lockb",
];

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

export interface WorkspaceOptions {
	/** Absolute (or cwd-relative) directory that every emitted path is relative to. */
	projectRoot: string;
	tsconfig?: string;
	/**
	 * Explicit `playwright.config.*` path. Suppresses discovery entirely: a
	 * caller who names a config and silently gets a different one read is worse
	 * off than one told the file is missing.
	 */
	playwrightConfig?: string;
	include?: string[];
	exclude?: string[];
	maxFiles?: number;
	/** Overrides the `data-testid` attribute name; wins over playwright.config. */
	attribute?: string;
	/** Set to `false` to skip the per-call mtime sweep when batching tool calls. */
	revalidate?: boolean;
	staleAfterMs?: number;
	/** Extra module specifiers treated as the library (defaults to the package name). */
	libraryModules?: string[];
	preferSyntacticResolution?: boolean;
}

export interface RevalidateResult {
	changed: string[];
	added: string[];
	removed: string[];
}

interface MemoEntry {
	signature: string;
	value: unknown;
}

/** A file's mtime as a comparable string, or a stable marker when it is gone. */
function mtimeOf(filePath: string): string {
	try {
		return String(fs.statSync(filePath).mtimeMs);
	} catch {
		return "missing";
	}
}

function normalizeRoot(projectRoot: string): string {
	return path.resolve(projectRoot);
}

/**
 * Cache identity. Every option that changes what the workspace *contains* or
 * how it is analysed belongs here: reusing a workspace built with a laxer
 * `maxFiles` would silently defeat a later caller's safety cap.
 *
 * `revalidate` and `staleAfterMs` are deliberately absent. They say how fresh
 * *this* call needs the answer, not what the workspace holds, so keying on them
 * would build a second project over the same files; {@link Workspace.acquire}
 * applies the incoming value to the cached workspace instead.
 */
function workspaceKey(options: WorkspaceOptions): string {
	return [
		foldPath(normalizeRoot(options.projectRoot)),
		options.tsconfig ?? "",
		options.playwrightConfig ?? "",
		(options.include ?? []).join(","),
		(options.exclude ?? []).join(","),
		options.attribute ?? "",
		options.maxFiles ?? "",
		(options.libraryModules ?? []).join(","),
		options.preferSyntacticResolution ?? "",
	].join("::");
}

/**
 * Owns the ts-morph `Project` for one analysed root.
 *
 * Invalidation is an mtime sweep per call rather than `fs.watch`: it is
 * stateless, survives branch switches and bulk checkouts, needs no debounce,
 * and behaves on network or virtualised filesystems where watch events are
 * unreliable.
 */
export class Workspace {
	private static cache = new Map<string, Workspace>();

	readonly project: Project;
	readonly root: string;
	readonly options: WorkspaceOptions;
	readonly tsconfigPath: string | null;
	readonly warnings: Diagnostic[] = [];

	private readonly inMemory: boolean;
	private readonly mtimes = new Map<string, number>();
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
	private parsedTotal = UNKNOWN_TOTAL;
	private lastGlobAt = 0;
	/** Per-call freshness policy; the latest caller's value wins (see `acquire`). */
	private staleAfterMs: number;
	/** Set once the workspace is in the LRU, so it can evict itself. */
	private cacheKey: string | null = null;
	/**
	 * Fires if nothing acquires this workspace for {@link IDLE_EVICT_AFTER_MS}.
	 * `unref`ed, so a pending eviction never holds the process open — a CLI that
	 * has answered its one question still exits immediately.
	 */
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	/** So the large-scan note is stated once, not on every revalidation sweep. */
	private largeScanNoted = false;
	private playwrightInfo: {
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
	private discovery: ConfigDiscovery | null = null;
	private fileList: { epoch: number; value: SourceFile[] } | null = null;
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

	private constructor(
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

	/** LRU of 2, keyed by root + tsconfig + include/exclude. */
	static acquire(rawOptions: WorkspaceOptions): Workspace {
		const { options, missing } = withNormalizedScope(rawOptions);
		const key = workspaceKey(options);
		const existing = Workspace.cache.get(key);
		if (existing) {
			// Refresh recency.
			Workspace.cache.delete(key);
			Workspace.cache.set(key, existing);
			// Latest caller wins. `staleAfterMs` is a freshness policy, not part of
			// the workspace's identity, so a caller asking for immediate rescans
			// gets them even though an earlier caller built the workspace with a
			// long interval — and an omitted value means this caller wants the
			// default, not whatever the first one happened to pass.
			existing.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
			let reusable = true;
			if (options.revalidate !== false) {
				existing.revalidate();
				// After the sweep, so the config read behind this is the edited one.
				reusable = !existing.projectIdentityChanged();
			}
			if (reusable) {
				existing.noteMissingScope(missing);
				existing.touch();
				return existing;
			}
			// `testDir` or the tsconfig moved, so this project holds the wrong files
			// under the wrong compiler options and no sweep can fix that — the file
			// set was decided when it was built. Rebuilding is the only correct
			// answer, and it happens here rather than inside a method because a
			// method cannot replace `this`.
			existing.clearIdleTimer();
			Workspace.cache.delete(key);
		}

		const created = Workspace.create(options);
		created.cacheKey = key;
		created.noteMissingScope(missing);
		Workspace.cache.set(key, created);
		created.touch();
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
		while (Workspace.cache.size > LRU_SIZE) {
			const oldest = Workspace.cache.entries().next();
			if (oldest.done) {
				break;
			}
			oldest.value[1].clearIdleTimer();
			Workspace.cache.delete(oldest.value[0]);
		}
		return created;
	}

	/** Drops every cached workspace. Tests use this to stay hermetic. */
	static reset(): void {
		for (const workspace of Workspace.cache.values()) {
			workspace.clearIdleTimer();
		}
		Workspace.cache.clear();
	}

	/**
	 * Restarts the idle countdown. Called on every acquire, so the timer measures
	 * silence rather than age — a session in continuous use never evicts.
	 */
	private touch(idleMs: number = IDLE_EVICT_AFTER_MS): void {
		this.clearIdleTimer();
		if (this.cacheKey === null) {
			return;
		}
		const key = this.cacheKey;
		this.idleTimer = setTimeout(() => {
			// Only if this exact instance is still the cached one: a rebuild under
			// the same key must not be evicted by its predecessor's timer.
			if (Workspace.cache.get(key) === this) {
				Workspace.cache.delete(key);
			}
			this.idleTimer = null;
		}, idleMs);
		this.idleTimer.unref?.();
	}

	private clearIdleTimer(): void {
		if (this.idleTimer !== null) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
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
				// Gone since the sweep, which already reported the files it held.
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
	 * Only the root's. A monorepo installs at its root, and a workspace rooted at
	 * a package below it will see the change on its own lockfile if it has one.
	 */
	private lockfileChanged(): boolean {
		let stamp = 0;
		for (const name of LOCKFILE_NAMES) {
			try {
				stamp += fs.statSync(path.join(this.root, name)).mtimeMs;
			} catch {
				// Absent: contributes nothing, and stays contributing nothing.
			}
		}
		const previous = this.lockfileStamp;
		this.lockfileStamp = stamp;
		// The first sweep establishes the baseline rather than reporting a change.
		return previous !== null && previous !== stamp;
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

	static get cacheSize(): number {
		return Workspace.cache.size;
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

	private static create(options: WorkspaceOptions): Workspace {
		const root = normalizeRoot(options.projectRoot);
		// The Playwright config is read from a throwaway project so that
		// `testDir` can steer tsconfig discovery before the real one is built.
		//
		// The probe deliberately carries no tsconfig: it exists before the real
		// project's compiler options are known, so a base config imported through
		// a `paths` alias cannot be followed here. That costs at most one hop of
		// the layer read during workspace construction; the memoized
		// `playwright()` on the real workspace redoes it with the right options.
		const probe = new Project({
			useInMemoryFileSystem: false,
			skipAddingFilesFromTsConfig: true,
			skipFileDependencyResolution: true,
			compilerOptions: synthesizedCompilerOptions(),
		});
		const probeWorkspace = new Workspace(probe, options, null, false);
		// One filesystem walk per workspace: the ranked list is handed to the real
		// workspace below rather than re-globbed there.
		const discovery = probeWorkspace.configDiscovery();
		const playwright = readPlaywrightConfig(
			probeWorkspace,
			options.playwrightConfig,
			discovery,
		);
		// Playwright defaults `testDir` to the directory holding the config, so a
		// nested `e2e/playwright.config.ts` that omits it still means `e2e/`.
		// Passing `undefined` here instead hid an adjacent `e2e/tsconfig.json` and
		// dropped the project onto synthesized options plus a repo-wide scan,
		// which loses that config's path aliases and include/exclude rules.
		//
		// That default is only Playwright's when the property is *absent*. A
		// `testDir` the config computes (`process.env.DIR`) names some other
		// directory, so substituting the config's own would adopt a neighbouring
		// tsconfig Playwright never reads and analyse the wrong source scope under
		// the wrong compiler options. An unknown test dir is left unknown; the
		// `testdir-unresolved` note the parser attached says why.
		const testDir = playwright.testDirUnresolved
			? undefined
			: (playwright.testDir ?? configDirOf(playwright.configFile));

		const located = locateTsConfig(root, options.tsconfig, testDir);
		const warnings: Diagnostic[] = [];

		const narrowed = (options.include?.length ?? 0) > 0;
		let project: Project;
		if (located.path) {
			// Before the parse, not after it: loading the tsconfig's sources reads
			// and parses the whole source set, which is the exact cost the cap exists
			// to refuse.
			precheckMaxFiles(root, options, located.path);
			project = new Project({
				tsConfigFilePath: located.path,
				// A narrowed scope counts only the files inside it, so it must not
				// then parse everything outside it: the include globs below add what
				// the caller actually asked for, and the resolver pulls in any file
				// they import. The tsconfig is still read — its `compilerOptions` are
				// what make the ASTs right — only its file set is skipped.
				skipAddingFilesFromTsConfig: narrowed,
				skipFileDependencyResolution: true,
			});
		} else {
			project = new Project({
				skipAddingFilesFromTsConfig: true,
				skipFileDependencyResolution: true,
				compilerOptions: synthesizedCompilerOptions(),
			});
			// Same rule as the tsconfig branch above: a narrowed scope must not
			// parse everything outside it first and filter afterwards. The include
			// globs below are the whole scan then, and the resolver pulls in what
			// they import — which is what makes the cap on files parsed mean
			// something on a repository with no tsconfig.
			if (!narrowed) {
				project.addSourceFilesAtPaths([
					...defaultIncludeGlobs(root),
					...defaultExcludeGlobs(root),
					...scopeExcludeGlobs(root, options.exclude),
				]);
			}
			warnings.push(
				info(
					"no-tsconfig",
					`No tsconfig.json found under ${toPosix(root)}; falling back to a ${SCAN_GLOB} scan with synthesized compiler options.`,
				),
			);
		}

		if (narrowed && options.include) {
			project.addSourceFilesAtPaths([
				...options.include.map((glob) => absoluteGlob(root, glob)),
				...defaultExcludeGlobs(root),
				...scopeExcludeGlobs(root, options.exclude),
			]);
		}

		const workspace = new Workspace(
			project,
			options,
			located.path,
			false,
			discovery,
		);
		workspace.warnings.push(...warnings);
		return workspace;
	}

	/* ---------------------------------------------------------------------- */

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

	/**
	 * Records scope directories that are not on disk.
	 *
	 * A `--src-dir` naming a directory that does not exist expands to a glob that
	 * matches nothing, and the analysis then reports an empty project as if the
	 * repository were empty. The stat has already happened inside
	 * {@link normalizeScopePattern}; this is only where its verdict is said out
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
	private rescan(): SourceFile[] {
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
	private rediscoverConfigs(): void {
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

	private recordMtimes(): void {
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

	private enforceMaxFiles(
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
		if (evictOnFailure && this.cacheKey !== null) {
			if (Workspace.cache.get(this.cacheKey) === this) {
				Workspace.cache.delete(this.cacheKey);
			}
			this.cacheKey = null;
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

/**
 * Whether a file the project holds is one the `maxFiles` cap counts.
 *
 * Everything parsed and retained, less what costs nothing to keep: a
 * declaration file carries no analysable code, and an ignored path
 * (`node_modules`, build output) is never the repository's own source.
 *
 * What is deliberately *not* applied here is the include/exclude scope. The cap
 * is documented as a cap on files parsed, and `--src-dir` says which files are
 * analysed, not how many the project may hold. Counting only the narrowed scope
 * meant a project sitting exactly on the cap could import unlimited siblings
 * outside it — every one of them parsed, retained and paid for — without ever
 * reaching `max_files_exceeded`. The analysed set ({@link isAnalysable}) is a
 * subset of this one, so a repository within the cap stays within it.
 */
function countsAgainstCap(absolute: string, relative: string): boolean {
	return !isDeclarationFile(absolute) && !isIgnoredPath(relative);
}

/**
 * Whether one file belongs to the analysed project.
 *
 * Shared by `sourceFiles()` and the pre-scan `maxFiles` check, so the pre-check
 * never counts a file the loaded project would have dropped and rejects a
 * repository that is actually within the cap. It is a strict subset of
 * {@link countsAgainstCap}, which is what the cap itself counts: what may be
 * *analysed* is narrower than what may be *parsed*.
 */
function isAnalysable(
	absolute: string,
	relative: string,
	include: string[],
	exclude: string[],
): boolean {
	if (isDeclarationFile(absolute)) {
		return false;
	}
	if (isOutsideRoot(relative) || isIgnoredPath(relative)) {
		return false;
	}
	if (include.length > 0 && !matchesAnyGlob(relative, include)) {
		return false;
	}
	if (exclude.length > 0 && matchesAnyGlob(relative, exclude)) {
		return false;
	}
	return true;
}

/**
 * Playwright's implicit `testDir`: the directory the config file sits in.
 *
 * `configFile` is workspace-relative, so a root-level config yields `"."` — the
 * project root, which {@link locateTsConfig} has already checked by the time it
 * looks at the test dir. Returning `undefined` for that case keeps the walk from
 * re-stating a path it just rejected.
 */
function configDirOf(configFile: string | null): string | undefined {
	if (!configFile) {
		return undefined;
	}
	const dir = path.posix.dirname(toPosix(configFile));
	return dir === "." || dir === "" ? undefined : dir;
}

/**
 * Refuses an oversized tsconfig before its sources are parsed.
 *
 * Silent when the config cannot be read: the constructor's `enforceMaxFiles()`
 * is still the authority, this only moves the rejection earlier for the common
 * case.
 *
 * It counts what the project is about to *parse*, which is what the cap
 * counts — {@link countsAgainstCap}, not the analysed subset. Counting the
 * analysed subset let an oversized tsconfig whose sources sit outside the
 * analysed root through the pre-check entirely: every one of those files was
 * read and parsed, and only then rejected, which is the whole cost this
 * function exists to avoid.
 *
 * A narrowed scope is the one exception, and not a special case so much as the
 * same rule: that project is built with `skipAddingFilesFromTsConfig`, so the
 * tsconfig's file set is never parsed at all and only the part of it the scope
 * selects can honestly be counted here.
 */
function precheckMaxFiles(
	root: string,
	options: WorkspaceOptions,
	tsConfigPath: string,
): void {
	const fileNames = tsConfigFileNames(tsConfigPath);
	if (!fileNames) {
		return;
	}
	const include = options.include ?? [];
	const exclude = options.exclude ?? [];
	const narrowed = include.length > 0;
	let count = 0;
	for (const absolute of fileNames) {
		const relative = toPosixRelative(root, absolute);
		if (!countsAgainstCap(absolute, relative)) {
			continue;
		}
		if (narrowed && !isAnalysable(absolute, relative, include, exclude)) {
			continue;
		}
		count += 1;
	}
	const limit = options.maxFiles ?? DEFAULT_MAX_FILES;
	if (count > limit) {
		throw new AnalysisLimitError(limit, count);
	}
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
function withNormalizedScope(options: WorkspaceOptions): {
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
function scopeExcludeGlobs(
	root: string,
	exclude: readonly string[] | undefined,
): string[] {
	return (exclude ?? []).map((glob) => absoluteGlob(root, `!${glob}`));
}

function absoluteGlob(root: string, glob: string): string {
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
