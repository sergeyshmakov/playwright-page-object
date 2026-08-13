import * as path from "node:path";
import { exports as resolveExports } from "resolve.exports";
import type { Project, SourceFile } from "ts-morph";
import {
	isInNodeModules,
	isRelativeSpecifier,
	loadFromBase,
	mappedModuleBases,
	resolveRelativeModule,
} from "./moduleFile";
import { isIgnoredPath, toPosix } from "./paths";
import {
	clearRealPathCache,
	hasWorkspaceRoot,
	isUnderWorkspaceRoot,
	isWorkspaceLocal,
	linkedWorkspaceDirectory,
	linkedWorkspaceFile,
	realDirectory,
} from "./workspaceRoot";

/**
 * Which file a bare specifier names, after walking `node_modules` and
 * reading the package's own `exports` table for unbuilt source.
 *
 * Split out of `resolve.ts`, which keeps the vocabulary a resolution is
 * reported in and the entry points that produce one.
 */

/**
 * Outcome of probing a bare specifier for a *linked workspace package*.
 *
 * `"built-output"` is a distinct, teachable answer: the package is first-party,
 * but the only thing resolvable under it is compiled JavaScript, which carries
 * no JSX and no test ids. Saying so beats both "external dependency" (wrong
 * about whose code it is) and parsing `dist/` (right about nothing).
 */
export type WorkspaceProbe =
	| { kind: "file"; file: SourceFile }
	| { kind: "built-output" }
	| { kind: "none" };

const NONE: WorkspaceProbe = { kind: "none" };

/**
 * Directory levels walked up looking for a `node_modules` directory.
 *
 * A cost backstop, not the stop condition: the walk already ends at the
 * filesystem root and at the analysed root, and the second of those is what
 * makes it correct — a `node_modules` above the project belongs to somebody
 * else. Ten cut in *before* either, so a source ten or more levels below the
 * root never reached the root's own `node_modules` and its linked workspace
 * packages were classified external — first-party code reported as a
 * third-party boundary, in a repository deep enough that nobody would suspect
 * the depth.
 *
 * Same mistake as the ten-hop cap `packageSourceOutsideRoot` carried, fixed in
 * 1e48f75 for the probe and left standing here.
 */
const MAX_NODE_MODULES_HOPS = 64;

/**
 * Fields a workspace package may point its source at, most source-like first.
 * `loadFromBase` maps a built `.js` name back to its `.ts`/`.tsx` sibling, so a
 * package that only declares `main: "dist/index.js"` still resolves when the
 * sources sit next to it.
 */
const PACKAGE_SOURCE_FIELDS = [
	"source",
	"module",
	"main",
	"types",
	"typings",
] as const;

/** Separator that cannot occur in a path or in a module specifier. */
const CACHE_FIELD = "\u0000";

interface ProbeCache {
	/** Importing directory and specifier, joined, to the probe's outcome. */
	specifiers: Map<string, WorkspaceProbe>;
	/** Real package directory to its parsed `package.json`, or `null`. */
	manifests: Map<string, Record<string, unknown> | null>;
	/** Real package directory to the entry bases its `package.json` declares. */
	entries: Map<string, string[]>;
}

const probeCaches = new WeakMap<Project, ProbeCache>();

function probeCacheOf(project: Project): ProbeCache {
	let cache = probeCaches.get(project);
	if (!cache) {
		cache = { specifiers: new Map(), manifests: new Map(), entries: new Map() };
		probeCaches.set(project, cache);
	}
	return cache;
}

/**
 * Drops everything the resolver remembers about a project's filesystem.
 *
 * Every entry here is a statement about files as they were when it was made:
 * "this package resolves to no source", "its manifest points at `dist`", "this
 * `SourceFile` is its entry point". None survives an edit. Left in place across
 * a long-lived session, the first answer outlived its evidence — a package kept
 * being reported missing or built-only after its sources appeared, and a
 * cached `SourceFile` that revalidation had since removed from the project was
 * still handed out as the resolution.
 *
 * Called from `Workspace.bumpEpoch()`, which is exactly the event that says the
 * files are no longer what they were.
 */
export function clearResolutionCaches(project: Project): void {
	probeCaches.delete(project);
	clearRealPathCache(project);
}

/** `@scope/name` or `name`, plus whatever subpath follows it. */
function splitPackageSpecifier(
	specifier: string,
): { name: string; subpath: string } | null {
	if (specifier.startsWith(".") || specifier.startsWith("/")) {
		return null;
	}
	const segments = specifier.split("/");
	const spanned = segments[0].startsWith("@") ? 2 : 1;
	if (segments.length < spanned || segments[spanned - 1] === "") {
		return null;
	}
	return {
		name: segments.slice(0, spanned).join("/"),
		subpath: segments.slice(spanned).join("/"),
	};
}

/**
 * Condition sets an `exports` entry is read under, most source-seeking first.
 *
 * A monorepo points `source` (or `development`) at the unbuilt file precisely so
 * tooling like this can find it, and finding it is the whole reason the engine
 * reads the table at all: a linked workspace package must expand to its `.tsx`,
 * not to the `dist/` it publishes.
 *
 * `resolve.exports` answers with one winner per call, and between two conditions
 * that are both allowed the *package's* key order decides — Node's rule, and the
 * wrong tie-break for this engine. One call per set, concatenated, restores the
 * preference: a `source` target is offered ahead of an `import` one however the
 * manifest happens to order them.
 *
 * The later sets keep `source` and `development` alongside so that a source
 * target nested *inside* a branch (`{"import": {"source": …, "default": …}}`)
 * still wins within that branch.
 */
const EXPORT_CONDITION_PASSES: readonly (readonly string[])[] = [
	["source"],
	["development"],
	["source", "development", "import"],
	["source", "development", "require"],
];

/** The package's parsed `package.json`, read at most once per package. */
function packageManifest(
	project: Project,
	realPackageDir: string,
): Record<string, unknown> | null {
	const cache = probeCacheOf(project);
	const cached = cache.manifests.get(realPackageDir);
	if (cached !== undefined) {
		return cached;
	}
	let manifest: Record<string, unknown> | null = null;
	try {
		const text = project
			.getFileSystem()
			.readFileSync(path.posix.join(realPackageDir, "package.json"));
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object") {
			manifest = parsed as Record<string, unknown>;
		}
	} catch {
		// No manifest, or unreadable: the conventional layouts still apply.
	}
	cache.manifests.set(realPackageDir, manifest);
	return manifest;
}

/**
 * Entry path bases a package declares, resolved against its real directory.
 *
 * `exports["."]` is consulted for the conditions a monorepo uses to point at
 * unbuilt sources; everything else is the classic field set. Conventional
 * source layouts are appended so a package with no usable field still resolves.
 */
function packageEntryBases(project: Project, realPackageDir: string): string[] {
	const cache = probeCacheOf(project);
	const cached = cache.entries.get(realPackageDir);
	if (cached) {
		return cached;
	}
	const bases: string[] = [];
	const add = (value: unknown): void => {
		if (typeof value === "string" && value !== "") {
			bases.push(path.posix.join(realPackageDir, toPosix(value)));
		}
	};
	const manifest = packageManifest(project, realPackageDir);
	// A `null` root entry is not honoured the way a blocked *subpath* is: the
	// classic fields and the conventional layouts below are the whole point of
	// the root probe, and refusing source the engine can plainly see because the
	// package declines to publish its own entry point helps nobody.
	for (const target of exportedTargets(manifest, ".").targets) {
		add(target);
	}
	for (const field of PACKAGE_SOURCE_FIELDS) {
		add(manifest?.[field]);
	}
	bases.push(path.posix.join(realPackageDir, "src/index"));
	bases.push(path.posix.join(realPackageDir, "index"));
	cache.entries.set(realPackageDir, bases);
	return bases;
}

/**
 * A `null` target — the package saying "this subpath is not importable" —
 * spelled as something `resolve.exports` will hand straight back.
 *
 * The library reports a blocked entry and an undeclared one through the same
 * error, and the difference decides the answer here: an undeclared subpath
 * still falls back to a plain join, because a package consumed through classic
 * node resolution never had its `exports` table read at all, while a blocked one
 * has to be refused. Masking the nulls before the lookup leaves the library
 * doing all of the matching — patterns, nesting, arrays — and still tells the
 * two outcomes apart.
 */
const BLOCKED_TARGET = `./${CACHE_FIELD}blocked`;

/** Every `null` in an `exports` tree, rewritten to {@link BLOCKED_TARGET}. */
function maskBlockedTargets(value: unknown): unknown {
	if (value === null) {
		return BLOCKED_TARGET;
	}
	if (Array.isArray(value)) {
		return value.map(maskBlockedTargets);
	}
	if (typeof value === "object") {
		const masked: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			masked[key] = maskBlockedTargets(entry);
		}
		return masked;
	}
	return value;
}

/**
 * The manifest as `resolve.exports` should see it, built once per package.
 *
 * Keyed by the parsed manifest itself, which the probe cache already holds one
 * of per package directory, so the mask is paid once however many subpaths the
 * repository imports from that package.
 */
const exportsViews = new WeakMap<object, Record<string, unknown>>();

function resolverView(
	manifest: Record<string, unknown>,
): Record<string, unknown> {
	const cached = exportsViews.get(manifest);
	if (cached) {
		return cached;
	}
	const view = { ...manifest, exports: maskBlockedTargets(manifest.exports) };
	exportsViews.set(manifest, view);
	return view;
}

interface ExportLookup {
	/** Package-relative targets the table offers, most source-like first. */
	targets: string[];
	/** The table names this entry and maps it to `null`. */
	blocked: boolean;
}

/**
 * Every target a package's `exports` table offers for one entry.
 *
 * `resolve.exports` owns the matching — exact keys, the longest `*` pattern,
 * trailing-slash folders, nested condition objects, fallback arrays and `null`
 * — which is a good deal more of Node's algorithm than this engine has any
 * business re-implementing. What is left here is the fan-out: the library
 * answers one condition set at a time, and the engine wants every source-like
 * answer, ordered.
 */
function exportedTargets(
	manifest: Record<string, unknown> | null,
	entry: string,
): ExportLookup {
	if (!manifest?.exports) {
		return { targets: [], blocked: false };
	}
	const pkg = resolverView(manifest);
	let sawBlocked = false;
	const pass = (conditions: readonly string[]): string[] => {
		let resolved: readonly string[];
		try {
			resolved = resolveExports(pkg, entry, { unsafe: true, conditions }) ?? [];
		} catch {
			// The entry is out of this condition set's reach. Another set may
			// still reach it, and none reaching it is an ordinary "not declared".
			return [];
		}
		const kept: string[] = [];
		for (const target of resolved) {
			if (target === BLOCKED_TARGET) {
				sawBlocked = true;
			} else if (target !== "") {
				kept.push(toPosix(target));
			}
		}
		return kept;
	};
	// `default` cannot be switched off — the library allows it in every call — so
	// what it answers on its own is subtracted from the conditional passes and
	// appended last. Otherwise a package whose `default` points at a build output
	// this engine does not recognise as one (`./lib/index.js`) would be tried
	// ahead of the source the `import` condition names.
	const fallback = pass([]);
	const fromFallback = new Set(fallback);
	const targets: string[] = [];
	const seen = new Set<string>();
	const push = (target: string): void => {
		if (!seen.has(target)) {
			seen.add(target);
			targets.push(target);
		}
	};
	for (const conditions of EXPORT_CONDITION_PASSES) {
		for (const target of pass(conditions)) {
			if (!fromFallback.has(target)) {
				push(target);
			}
		}
	}
	for (const target of fallback) {
		push(target);
	}
	return { targets, blocked: sawBlocked && targets.length === 0 };
}

/**
 * Path bases a package's `exports` table maps one subpath to.
 *
 * A design system that publishes `"./Button": "./src/Button.tsx"` is imported
 * as `@acme/ui/Button`, and `<package>/Button` — the only thing a
 * package-root-relative guess can produce — is not a file. Consulting the table
 * is the difference between expanding a first-party component and reporting the
 * repository's own design system as an external dependency.
 */
function exportedSubpathBases(
	project: Project,
	realPackageDir: string,
	subpath: string,
): { bases: string[]; blocked: boolean } {
	const manifest = packageManifest(project, realPackageDir);
	const { targets, blocked } = exportedTargets(manifest, `./${subpath}`);
	return {
		blocked,
		bases: targets.map((target) => path.posix.join(realPackageDir, target)),
	};
}

/**
 * Resolves a bare specifier that names a workspace package linked into
 * `node_modules`.
 *
 * `import { Gapped } from "@company/ui"` with no tsconfig `paths` entry never
 * reaches disk otherwise — it is reported external, and every component the
 * design system owns becomes a hole in the tree even though its sources are
 * right there in the repository.
 *
 * Hard-capped on purpose, because this is the only code in the engine that
 * walks directories and reads a `package.json`: at most
 * {@link MAX_NODE_MODULES_HOPS} levels up and never above the workspace root,
 * one manifest read per package, every `realpath` cached, and every load still
 * gated by `admitAddedFile` so `maxFiles` holds. Without a registered root
 * there is nothing to bound the walk or to judge the link against, so the probe
 * is off entirely.
 */
export function probeWorkspacePackage(
	project: Project,
	fromFile: SourceFile,
	specifier: string,
): WorkspaceProbe {
	if (!hasWorkspaceRoot(project)) {
		return NONE;
	}
	const split = splitPackageSpecifier(specifier);
	if (!split) {
		return NONE;
	}
	const fromDirectory = toPosix(fromFile.getDirectoryPath());
	const cache = probeCacheOf(project);
	const key = `${fromDirectory}${CACHE_FIELD}${specifier}`;
	const cached = cache.specifiers.get(key);
	if (cached) {
		return cached;
	}
	const outcome = probeUncached(project, fromDirectory, split);
	cache.specifiers.set(key, outcome);
	return outcome;
}

function probeUncached(
	project: Project,
	fromDirectory: string,
	split: { name: string; subpath: string },
): WorkspaceProbe {
	const fileSystem = project.getFileSystem();
	let directory = fromDirectory;
	for (let hop = 0; hop < MAX_NODE_MODULES_HOPS; hop += 1) {
		const candidate = path.posix.join(directory, "node_modules", split.name);
		if (fileSystem.directoryExistsSync(candidate)) {
			// Either the link leads back into the workspace, or this is an ordinary
			// installed dependency and today's answer stands. One syscall, cached
			// for every later file in the same package.
			const real = linkedWorkspaceDirectory(project, candidate);
			return real === null
				? NONE
				: loadWorkspacePackage(project, real, split.subpath);
		}
		const parent = path.posix.dirname(directory);
		if (parent === directory) {
			break;
		}
		// Never above the analysed root: a `node_modules` outside it belongs to
		// somebody else's project.
		if (!isUnderWorkspaceRoot(project, parent)) {
			break;
		}
		directory = parent;
	}
	return NONE;
}

/**
 * Loads a file from inside a linked workspace package, always against the
 * package's **real** path.
 *
 * Loading it under the link path would enter the project as
 * `node_modules/…`, which `isAnalysable` drops from `sourceFiles()` — the ids
 * would reach the tree and never reach the inventory, and coverage would call
 * every selector for them dead.
 *
 * A subpath goes through the same candidate list and the same build-output gate
 * as the package root. It used to be joined onto the package directory and
 * loaded unconditionally, which both missed every subpath the package declares
 * through `exports` and let `@acme/ui/dist/Button` parse compiled output that
 * `sourceFiles()` then excludes — a node in the tree whose file is in no
 * inventory, which is the exact disagreement between tree and coverage this
 * function exists to prevent.
 */
function loadWorkspacePackage(
	project: Project,
	realPackageDir: string,
	subpath: string,
): WorkspaceProbe {
	let bases: string[];
	if (subpath === "") {
		bases = packageEntryBases(project, realPackageDir);
	} else {
		const declared = exportedSubpathBases(project, realPackageDir, subpath);
		// `"./internal/*": null` is the package refusing the subpath outright, and
		// that is worth honouring. An entry the table simply does not name is not:
		// a package consumed through classic node resolution never had its
		// `exports` read, and the plain join is how those deep imports resolve.
		if (declared.blocked) {
			return NONE;
		}
		bases = [...declared.bases, path.posix.join(realPackageDir, subpath)];
	}
	let sawBuiltOutput = false;
	for (const base of bases) {
		// An `exports` target is free to point anywhere; one that climbs out of
		// its own package is not this package's source.
		if (!base.startsWith(`${realPackageDir}/`)) {
			continue;
		}
		if (isIgnoredPath(base.slice(realPackageDir.length))) {
			sawBuiltOutput = true;
			continue;
		}
		const found = loadFromBase(project, base);
		if (found) {
			return { kind: "file", file: found };
		}
	}
	return sawBuiltOutput ? { kind: "built-output" } : NONE;
}

/**
 * Resolves any module specifier the analysed project can own: relative,
 * non-relative through the tsconfig `paths` table or `baseUrl`, or a bare
 * specifier naming a workspace package linked into `node_modules`.
 *
 * Without the alias half, a repo that writes `@/components/Cart` has every
 * import classified as external, so nested controls and component trees stop
 * dead at the first aliased hop even though the file is right there in the
 * project. An alias landing in an *installed* dependency is still rejected —
 * the engine never parses `node_modules` — but a workspace package linked
 * through it is first-party source and is resolved to its real path.
 */
export function resolveModuleSpecifier(
	project: Project,
	fromFile: SourceFile,
	specifier: string,
): SourceFile | undefined {
	if (isRelativeSpecifier(specifier)) {
		return resolveRelativeModule(project, fromFile, specifier);
	}
	for (const mapped of mappedModuleBases(project, specifier)) {
		// Rejected *before* `loadFromBase`, not after: adding the file to the
		// project first would parse a dependency into the AST only to throw the
		// result away, which is exactly the boundary the engine promises to hold.
		// The real-path test is what keeps a `paths` entry that already points at
		// `node_modules/<workspace-pkg>` from being read as a dependency.
		let base = mapped;
		if (isInNodeModules(base)) {
			// An alias aimed at a linked workspace package is admitted, but only
			// under the package's real path. Loading it under the link spelling put
			// the file in the project as `node_modules/…`, where `sourceFiles()`
			// drops it: the ids reached the tree and never reached the inventory.
			const real = linkedWorkspaceFile(project, base);
			if (real === null) {
				continue;
			}
			base = real;
		}
		const found = loadFromBase(project, base);
		if (found && isWorkspaceLocal(project, found.getFilePath())) {
			return found;
		}
	}
	const probed = probeWorkspacePackage(project, fromFile, specifier);
	return probed.kind === "file" ? probed.file : undefined;
}
