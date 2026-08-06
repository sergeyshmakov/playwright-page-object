import * as fs from "node:fs";
import * as path from "node:path";
import {
	FileSystemRefreshResult,
	type Node,
	Project,
	type SourceFile,
} from "ts-morph";
import { readPlaywrightConfig } from "./config/playwrightConfig";
import {
	defaultExcludeGlobs,
	defaultIncludeGlobs,
	locateTsConfig,
	SCAN_GLOB,
	synthesizedCompilerOptions,
	tsConfigFileNames,
} from "./config/tsconfig";
import { AnalysisLimitError, dedupeDiagnostics, info } from "./diagnostics";
import type {
	Diagnostic,
	PlaywrightConfigInfo,
	SourceLoc,
	TestIdAttributeSource,
} from "./types";
import {
	foldPath,
	isDeclarationFile,
	isIgnoredPath,
	isOutsideRoot,
	matchesAnyGlob,
	toPosix,
	toPosixRelative,
} from "./util/paths";

export const DEFAULT_TEST_ID_ATTRIBUTE = "data-testid";
/** Matches the documented `--max-files` default in `src/cli.ts` and the docs. */
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_STALE_AFTER_MS = 1000;
const LRU_SIZE = 2;

export interface WorkspaceOptions {
	/** Absolute (or cwd-relative) directory that every emitted path is relative to. */
	projectRoot: string;
	tsconfig?: string;
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
 */
function workspaceKey(options: WorkspaceOptions): string {
	return [
		foldPath(normalizeRoot(options.projectRoot)),
		options.tsconfig ?? "",
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
	private playwrightInfo: {
		epoch: number;
		value: PlaywrightConfigInfo;
	} | null = null;
	private fileList: { epoch: number; value: SourceFile[] } | null = null;

	private constructor(
		project: Project,
		options: WorkspaceOptions,
		tsconfigPath: string | null,
		inMemory: boolean,
	) {
		this.project = project;
		this.options = options;
		this.root = normalizeRoot(options.projectRoot);
		this.tsconfigPath = tsconfigPath;
		this.inMemory = inMemory;
		this.recordMtimes();
		this.enforceMaxFiles();
	}

	/** LRU of 2, keyed by root + tsconfig + include/exclude. */
	static acquire(rawOptions: WorkspaceOptions): Workspace {
		const options = withNormalizedScope(rawOptions);
		const key = workspaceKey(options);
		const existing = Workspace.cache.get(key);
		if (existing) {
			// Refresh recency.
			Workspace.cache.delete(key);
			Workspace.cache.set(key, existing);
			if (options.revalidate !== false) {
				existing.revalidate();
			}
			return existing;
		}

		const created = Workspace.create(options);
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
		return new Workspace(
			project,
			withNormalizedScope(options),
			meta?.tsconfigPath ?? null,
			meta?.inMemory ?? true,
		);
	}

	private static create(options: WorkspaceOptions): Workspace {
		const root = normalizeRoot(options.projectRoot);
		// The Playwright config is read from a throwaway project so that
		// `testDir` can steer tsconfig discovery before the real one is built.
		const probe = new Project({
			useInMemoryFileSystem: false,
			skipAddingFilesFromTsConfig: true,
			skipFileDependencyResolution: true,
			compilerOptions: synthesizedCompilerOptions(),
		});
		const probeWorkspace = new Workspace(probe, options, null, false);
		const playwright = readPlaywrightConfig(probeWorkspace);
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
			project.addSourceFilesAtPaths([
				...defaultIncludeGlobs(root),
				...defaultExcludeGlobs(root),
			]);
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

		const workspace = new Workspace(project, options, located.path, false);
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

	tsFiles(): SourceFile[] {
		return this.sourceFiles().filter((file) => !isJsxFile(file.getFilePath()));
	}

	jsxFiles(): SourceFile[] {
		return this.sourceFiles().filter((file) => isJsxFile(file.getFilePath()));
	}

	/** Memoized `playwright.config.*` read, refreshed once per epoch. */
	playwright(): PlaywrightConfigInfo {
		if (this.playwrightInfo && this.playwrightInfo.epoch === this.epoch) {
			return this.playwrightInfo.value;
		}
		const value = readPlaywrightConfig(this);
		this.playwrightInfo = { epoch: this.epoch, value };
		// A config that could not be read statically silently downgrades the
		// test-id attribute to `data-testid`; surface why, so consumers can say so
		// instead of reporting a confidently wrong attribute. "No config at all"
		// is not news and stays out of the workspace warnings.
		if (value.configFile !== null && value.notes.length > 0) {
			const merged = dedupeDiagnostics([...this.warnings, ...value.notes]);
			this.warnings.length = 0;
			this.warnings.push(...merged);
		}
		return value;
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

	/** Test hook: forces every epoch-scoped cache to miss. */
	bumpEpoch(): void {
		this.epoch += 1;
		this.fileList = null;
		this.playwrightInfo = null;
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
		const staleAfter = this.options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
		if (now - this.lastGlobAt >= staleAfter) {
			this.lastGlobAt = now;
			const before = new Set(
				this.project.getSourceFiles().map((file) => file.getFilePath()),
			);
			try {
				for (const sourceFile of this.rescan()) {
					if (!before.has(sourceFile.getFilePath())) {
						result.added.push(this.rel(sourceFile.getFilePath()));
					}
				}
			} catch {
				// A glob that matches nothing is not an error.
			}
		}

		if (
			result.changed.length > 0 ||
			result.added.length > 0 ||
			result.removed.length > 0
		) {
			this.recordMtimes();
			this.bumpEpoch();
			this.enforceMaxFiles();
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

	private enforceMaxFiles(): void {
		const limit = this.options.maxFiles ?? DEFAULT_MAX_FILES;
		const count = this.sourceFiles().length;
		if (count > limit) {
			throw new AnalysisLimitError(limit, count);
		}
	}
}

/**
 * Whether one file belongs to the analysed project.
 *
 * Shared by `sourceFiles()` and the pre-scan `maxFiles` check so the two count
 * the same set: a pre-check that counted more than the loaded project would
 * reject repositories that are actually within the cap.
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
 * case. Counting the same filtered set as `sourceFiles()` keeps it from
 * rejecting a project the real count would have allowed.
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
	let count = 0;
	for (const absolute of fileNames) {
		if (
			isAnalysable(absolute, toPosixRelative(root, absolute), include, exclude)
		) {
			count += 1;
		}
	}
	const limit = options.maxFiles ?? DEFAULT_MAX_FILES;
	if (count > limit) {
		throw new AnalysisLimitError(limit, count);
	}
}

/** Characters that make a pattern a glob rather than a plain path. */
const GLOB_MAGIC = /[*?[\]{}]/;
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
 * Whether a scope pattern names one file rather than a directory.
 *
 * Disk wins when the path exists, because a directory may perfectly well be
 * called `foo.config` or `.config` — treating it as a file by its trailing dot
 * segment left the pattern matching nothing at all and produced a silently
 * empty project. Only when nothing is there to stat does the extension decide,
 * and then only for extensions the scanner can really select a file with.
 */
function looksLikeSingleFile(root: string, body: string): boolean {
	try {
		return fs.statSync(path.resolve(root, body)).isFile();
	} catch {
		return SOURCE_FILE_EXTENSION.test(body);
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
function normalizeScopePattern(root: string, pattern: string): string {
	const negated = pattern.startsWith("!");
	const body = relativizeToRoot(root, negated ? pattern.slice(1) : pattern)
		.replace(/\/+$/, "")
		.replace(/^\.\//, "");
	let normalized: string;
	if (body === "" || body === ".") {
		normalized = DIRECTORY_EXPANSION;
	} else if (GLOB_MAGIC.test(body) || looksLikeSingleFile(root, body)) {
		normalized = body;
	} else {
		normalized = `${body}/${DIRECTORY_EXPANSION}`;
	}
	return negated ? `!${normalized}` : normalized;
}

/**
 * Normalizes the scoping options once, at the workspace boundary, so every
 * consumer (`addSourceFilesAtPaths`, `sourceFiles()`, `rescan()`) sees the
 * same globs.
 */
function withNormalizedScope(options: WorkspaceOptions): WorkspaceOptions {
	if (!options.include?.length && !options.exclude?.length) {
		return options;
	}
	const root = normalizeRoot(options.projectRoot);
	const normalize = (patterns: string[] | undefined) =>
		patterns?.map((pattern) => normalizeScopePattern(root, pattern));
	return {
		...options,
		include: normalize(options.include),
		exclude: normalize(options.exclude),
	};
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
