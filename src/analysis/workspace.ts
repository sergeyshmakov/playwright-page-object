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
	tsConfigFileNames,
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
	isDeclarationFile,
	isGlobPattern,
	isIgnoredPath,
	isOutsideRoot,
	matchesAnyGlob,
	toPosix,
	toPosixRelative,
} from "./util/paths";
import { clearResolutionCaches } from "./util/resolve";
import { registerWorkspaceRoot } from "./util/workspaceRoot";

export const DEFAULT_TEST_ID_ATTRIBUTE = "data-testid";
/** Matches the documented `--max-files` default in `src/cli.ts` and the docs. */
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_STALE_AFTER_MS = 1000;
const LRU_SIZE = 2;
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
	private lastGlobAt = 0;
	/** Per-call freshness policy; the latest caller's value wins (see `acquire`). */
	private staleAfterMs: number;
	/** Set once the workspace is in the LRU, so it can evict itself. */
	private cacheKey: string | null = null;
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
			if (options.revalidate !== false) {
				existing.revalidate();
			}
			existing.noteMissingScope(missing);
			return existing;
		}

		const created = Workspace.create(options);
		created.cacheKey = key;
		created.noteMissingScope(missing);
		Workspace.cache.set(key, created);
		while (Workspace.cache.size > LRU_SIZE) {
			const oldest = Workspace.cache.keys().next();
			if (oldest.done) {
				break;
			}
			Workspace.cache.delete(oldest.value);
		}
		return created;
	}

	/** Drops every cached workspace. Tests use this to stay hermetic. */
	static reset(): void {
		Workspace.cache.clear();
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
		const position = sourceFile.getLineAndColumnAtPos(node.getStart());
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
		// Every note, unconditionally. The old gate dropped everything a *missing*
		// config had to say — including "several configs exist" and "the one you
		// named is not there" — on the theory that no config is not news. On a
		// repository whose config the old fixed-basename probe never found, that
		// silence was the difference between a wrong answer and a wrong answer
		// nobody could see.
		if (value.notes.length > 0) {
			const merged = dedupeDiagnostics([...this.warnings, ...value.notes]);
			this.warnings.length = 0;
			this.warnings.push(...merged);
		}
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
			// First, and not for tidiness: this is what parses the Playwright config
			// and merges its notes into `this.warnings`.
			this.playwright();
			const collected: Diagnostic[] = [];
			const verdict = attributeVerdict(censusFromText(this, attribute), source);
			if (verdict) {
				collected.push(verdict);
			}
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
	 */
	memo<T>(key: string, fileDeps: string[], compute: () => T): T {
		const signature =
			fileDeps.length === 0
				? `epoch:${this.epoch}`
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
		if (missing.length === 0) {
			return;
		}
		for (const directory of missing) {
			this.warnings.push(
				warn(
					"scope-dir-missing",
					`The analysed directory "${directory}" does not exist under ${toPosix(this.root)}; nothing from it is in scope.`,
					undefined,
					{ path: directory },
				),
			);
		}
		const merged = dedupeDiagnostics(this.warnings);
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
	 */
	revalidate(): RevalidateResult {
		const result: RevalidateResult = { changed: [], added: [], removed: [] };
		if (this.inMemory) {
			return result;
		}

		for (const sourceFile of [...this.project.getSourceFiles()]) {
			const absolute = toPosix(sourceFile.getFilePath());
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
		if (now - this.lastGlobAt >= this.staleAfterMs) {
			this.lastGlobAt = now;
			const before = new Set(
				this.project.getSourceFiles().map((file) => file.getFilePath()),
			);
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

		if (
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
		return result;
	}

	/**
	 * Re-runs the scan that populated the project so newly created files appear.
	 *
	 * A tsconfig-backed project has to be rescanned through that same tsconfig:
	 * falling back to `defaultIncludeGlobs` would drag in sibling packages and
	 * the files the tsconfig deliberately excludes, silently widening every
	 * later result and eating into `maxFiles`.
	 */
	private rescan(): SourceFile[] {
		const include = this.options.include ?? [];
		if (include.length === 0 && this.tsconfigPath) {
			return this.project.addSourceFilesFromTsConfig(this.tsconfigPath);
		}
		const globs =
			include.length > 0
				? include.map((glob) => absoluteGlob(this.root, glob))
				: defaultIncludeGlobs(this.root);
		return this.project.addSourceFilesAtPaths([
			...globs,
			...defaultExcludeGlobs(this.root),
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
	private enforceMaxFiles(
		rollback: readonly SourceFile[] = [],
		evictOnFailure = false,
	): void {
		const limit = this.options.maxFiles ?? DEFAULT_MAX_FILES;
		const count = this.parsedCount();
		if (count <= limit) {
			return;
		}
		for (const sourceFile of rollback) {
			this.mtimes.delete(toPosix(sourceFile.getFilePath()));
			this.project.removeSourceFile(sourceFile);
		}
		this.fileList = null;
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
	 */
	private admitResolvedFile(added: SourceFile): void {
		const limit = this.options.maxFiles ?? DEFAULT_MAX_FILES;
		if (this.project.getSourceFiles().length > limit) {
			this.enforceMaxFiles([added]);
		}
		if (this.analysable(added)) {
			this.fileList = null;
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
