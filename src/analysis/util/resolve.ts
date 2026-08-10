import * as path from "node:path";
import { exports as resolveExports } from "resolve.exports";
import {
	type CompilerOptions,
	type ModuleDeclaration,
	Node,
	type Project,
	type SourceFile,
	SyntaxKind,
} from "ts-morph";
import type { DynamicReason } from "../types";
import { hasDefaultKeyword } from "./exports";
import { admitAddedFile } from "./fileBudget";
import { foldPath, isIgnoredPath, toPosix } from "./paths";
import {
	clearRealPathCache,
	hasWorkspaceRoot,
	isUnderWorkspaceRoot,
	isWorkspaceLocal,
	linkedWorkspaceDirectory,
	linkedWorkspaceFile,
} from "./workspaceRoot";

export type RefKind = "class" | "function" | "variable" | "other";

export interface ResolvedRef {
	resolved: true;
	kind: RefKind;
	/** Declared name, which may differ from the local alias used at the call site. */
	name: string;
	declaration: Node;
	sourceFile: SourceFile;
}

export interface ExternalRef {
	resolved: false;
	external: true;
	module: string;
	/** Exported name in the external module (`"default"` for a default import). */
	name: string;
}

export interface UnresolvedRef {
	resolved: false;
	external: false;
	name: string;
	reason: DynamicReason;
}

export type RefResolution = ResolvedRef | ExternalRef | UnresolvedRef;

/**
 * A name as written (`pages.HomePage`) next to the bare identifier it ends in
 * (`HomePage`).
 *
 * Resolution and library-alias lookup need the qualified form so a namespace
 * import stays analysable; everything user-facing reports the simple name.
 */
export interface NameRef {
	qualified: string;
	simple: string;
}

/** Reads `X` or `ns.X` from an expression position. */
export function readNameRef(node: Node): NameRef | null {
	if (Node.isIdentifier(node)) {
		const text = node.getText();
		return { qualified: text, simple: text };
	}
	if (Node.isPropertyAccessExpression(node)) {
		return {
			qualified: `${node.getExpression().getText()}.${node.getName()}`,
			simple: node.getName(),
		};
	}
	return null;
}

export interface ResolveOptions {
	/** Set to `false` to keep the type checker out of the hot path entirely. */
	preferSyntacticResolution?: boolean;
	/** Re-export hops (`export { X } from`, `export *`) to follow. */
	maxHops?: number;
}

const DEFAULT_HOPS = 4;

const EXTENSION_CANDIDATES = [
	".ts",
	".tsx",
	".mts",
	".cts",
	".d.ts",
	".js",
	".jsx",
];

/**
 * Cheap string test for a `node_modules` segment.
 *
 * Kept as the pre-gate in front of {@link isWorkspaceLocal}, which is the
 * authority: a workspace package linked into `node_modules` matches this and is
 * still first-party source.
 *
 * Folded where the filesystem folds, so the gate and the authority behind it
 * read a differently cased segment the same way.
 */
export function isInNodeModules(filePath: string): boolean {
	return foldPath(toPosix(filePath)).includes("/node_modules/");
}

export function isRelativeSpecifier(specifier: string): boolean {
	return specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * Resolves a module path prefix (no extension) to a file already in — or
 * addable to — the project, trying every extension and the `index.*` form.
 *
 * Deliberately *not* memoized. It looks like an obvious cache — 22 candidate
 * paths per call, the same base probed repeatedly — but measured against a
 * 4,924-file production monorepo it runs 2,087 times on the cold call and
 * 0–24 times on a warm one, with no failing filesystem read at all: the
 * candidate loop finds the file already in the project. Caching it bought
 * nothing measurable and would have added a *negative* cache, which goes stale
 * for a file created outside the scan globs — where nothing bumps the epoch
 * that would clear it.
 */
function loadFromBase(project: Project, base: string): SourceFile | undefined {
	const bases = [base];
	// NodeNext ESM style: `./x.js` on disk is `./x.ts`.
	const jsExt = /\.([cm]?)js$/.exec(base);
	if (jsExt) {
		bases.push(base.replace(/\.([cm]?)js$/, `.${jsExt[1]}ts`));
		bases.push(base.replace(/\.[cm]?js$/, ".ts"));
		bases.push(base.replace(/\.[cm]?js$/, ".tsx"));
	}

	const candidates: string[] = [];
	for (const candidateBase of bases) {
		candidates.push(candidateBase);
		for (const ext of EXTENSION_CANDIDATES) {
			candidates.push(candidateBase + ext);
		}
		for (const ext of EXTENSION_CANDIDATES) {
			candidates.push(path.posix.join(candidateBase, `index${ext}`));
		}
	}

	for (const candidate of candidates) {
		const existing = project.getSourceFile(candidate);
		if (existing) {
			return existing;
		}
	}
	for (const candidate of candidates) {
		if (!/\.[cm]?[jt]sx?$/.test(candidate)) {
			continue;
		}
		let added: SourceFile | undefined;
		try {
			added = project.addSourceFileAtPathIfExists(candidate);
		} catch {
			// A path that cannot be stat'ed is simply not a candidate.
			continue;
		}
		if (added) {
			// Outside the `try`: the cap gate throws `AnalysisLimitError`, and
			// swallowing that here would let an on-demand load grow the workspace
			// past `--max-files` unreported. It rolls the addition back first.
			admitAddedFile(project, added);
			return added;
		}
	}
	return undefined;
}

/**
 * Resolves a relative module specifier to a file already in — or addable to —
 * the project. Bare specifiers deliberately return `undefined`: use
 * {@link resolveModuleSpecifier}, which also consults the tsconfig `paths`
 * table. Neither ever walks into `node_modules`: library base classes are
 * identified by *name plus import source*, which is what lets the engine work
 * on a freshly cloned repo with no install.
 */
export function resolveRelativeModule(
	project: Project,
	fromFile: SourceFile,
	specifier: string,
): SourceFile | undefined {
	if (!isRelativeSpecifier(specifier)) {
		return undefined;
	}
	return loadFromBase(
		project,
		path.posix.join(toPosix(fromFile.getDirectoryPath()), toPosix(specifier)),
	);
}

/**
 * Directory the tsconfig `paths` entries are written relative to.
 *
 * `baseUrl` when there is one; otherwise TypeScript records the config's own
 * directory as `pathsBasePath` (paths without baseUrl, allowed since TS 4.1).
 */
function pathsBaseDir(options: CompilerOptions): string | undefined {
	const baseUrl = options.baseUrl;
	if (typeof baseUrl === "string" && baseUrl !== "") {
		return toPosix(baseUrl);
	}
	const pathsBasePath = (options as { pathsBasePath?: unknown }).pathsBasePath;
	if (typeof pathsBasePath === "string" && pathsBasePath !== "") {
		return toPosix(pathsBasePath);
	}
	return undefined;
}

/**
 * Splits a `paths` key into its prefix and suffix around the single `*`.
 *
 * TypeScript allows **at most one** `*` per pattern and ignores any key that
 * breaks that rule (`tryParsePattern`), so a two-star key matches nothing here
 * either — rather than silently substituting into the first star only.
 */
function parsePathsPattern(
	pattern: string,
): { exact: true } | { exact: false; prefix: string; suffix: string } | null {
	const star = pattern.indexOf("*");
	if (star < 0) {
		return { exact: true };
	}
	if (pattern.indexOf("*", star + 1) >= 0) {
		return null;
	}
	return {
		exact: false,
		prefix: pattern.slice(0, star),
		suffix: pattern.slice(star + 1),
	};
}

/**
 * Puts the matched wildcard text into a `paths` substitution.
 *
 * Same one-star rule as the pattern side: a substitution with a second `*` is
 * rejected by `tsc` (TS5062) and is dropped here instead of being half-filled.
 */
function applySubstitution(
	target: string,
	matchedStar: string | null,
): string | null {
	const star = target.indexOf("*");
	if (star < 0 || matchedStar === null) {
		return target;
	}
	if (target.indexOf("*", star + 1) >= 0) {
		return null;
	}
	return target.slice(0, star) + matchedStar + target.slice(star + 1);
}

/**
 * Absolute path prefixes the tsconfig `paths` table maps a specifier to.
 *
 * Only the *best* pattern contributes, as in TypeScript: an exact key wins
 * outright, otherwise the longest matching prefix does, and the first key of
 * that length wins a tie. Falling through to a shorter pattern when the best
 * one's targets do not exist would resolve `@/components/Cart` against a
 * catch-all `@/*` that TypeScript never consults.
 *
 * Returns `null` when no pattern matched at all — which is what lets the caller
 * fall back to `baseUrl`, exactly as `tryLoadModuleUsingPathsIfEligible` does.
 */
function pathsTargets(
	paths: Record<string, string[] | undefined>,
	base: string,
	specifier: string,
): string[] | null {
	let bestTargets: string[] | undefined;
	let bestStar: string | null = null;
	let bestPrefixLength = -1;

	for (const [pattern, targets] of Object.entries(paths)) {
		const parsed = parsePathsPattern(pattern);
		if (!parsed) {
			continue;
		}
		if (parsed.exact) {
			if (pattern === specifier) {
				// An exact key is unique and beats every wildcard.
				return substitutedBases(targets ?? [], null, base);
			}
			continue;
		}
		const { prefix, suffix } = parsed;
		if (
			!specifier.startsWith(prefix) ||
			!specifier.endsWith(suffix) ||
			specifier.length < prefix.length + suffix.length
		) {
			continue;
		}
		if (prefix.length <= bestPrefixLength) {
			continue;
		}
		bestPrefixLength = prefix.length;
		bestStar = specifier.slice(prefix.length, specifier.length - suffix.length);
		bestTargets = targets ?? [];
	}

	return bestTargets ? substitutedBases(bestTargets, bestStar, base) : null;
}

function substitutedBases(
	targets: string[],
	matchedStar: string | null,
	base: string,
): string[] {
	const out: string[] = [];
	for (const target of targets) {
		const substituted = applySubstitution(toPosix(target), matchedStar);
		if (substituted !== null) {
			out.push(path.posix.join(base, substituted));
		}
	}
	return out;
}

/**
 * Absolute path prefixes a non-relative specifier maps to.
 *
 * Two mechanisms, in TypeScript's own order: the tsconfig `paths` table, and —
 * when no pattern matched — plain `baseUrl` resolution, under which
 * `components/Cart` is a perfectly ordinary local import that needs no `paths`
 * entry at all.
 */
function mappedModuleBases(project: Project, specifier: string): string[] {
	const options = project.getCompilerOptions();
	const pathsBase = pathsBaseDir(options);
	if (options.paths && pathsBase) {
		const matched = pathsTargets(options.paths, pathsBase, specifier);
		// A matched pattern commits: TypeScript does not retry under `baseUrl`.
		if (matched) {
			return matched;
		}
	}
	const baseUrl = options.baseUrl;
	if (typeof baseUrl === "string" && baseUrl !== "") {
		return [path.posix.join(toPosix(baseUrl), specifier)];
	}
	return [];
}

/* -------------------------------------------------------------------------- */
/* Workspace packages behind a node_modules link                              */
/* -------------------------------------------------------------------------- */

/**
 * Outcome of probing a bare specifier for a *linked workspace package*.
 *
 * `"built-output"` is a distinct, teachable answer: the package is first-party,
 * but the only thing resolvable under it is compiled JavaScript, which carries
 * no JSX and no test ids. Saying so beats both "external dependency" (wrong
 * about whose code it is) and parsing `dist/` (right about nothing).
 */
type WorkspaceProbe =
	| { kind: "file"; file: SourceFile }
	| { kind: "built-output" }
	| { kind: "none" };

const NONE: WorkspaceProbe = { kind: "none" };

/** Directory levels walked up looking for a `node_modules` directory. */
const MAX_NODE_MODULES_HOPS = 10;

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
function probeWorkspacePackage(
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

interface ImportBinding {
	specifier: string;
	/** Name as exported by the target module; `"default"` / `"*"` are special. */
	exportedName: string;
}

/** Finds the import that introduces `localName` into `sourceFile`. */
export function findImportBinding(
	sourceFile: SourceFile,
	localName: string,
): ImportBinding | undefined {
	for (const declaration of sourceFile.getImportDeclarations()) {
		const specifier = declaration.getModuleSpecifierValue();
		const defaultImport = declaration.getDefaultImport();
		if (defaultImport && defaultImport.getText() === localName) {
			return { specifier, exportedName: "default" };
		}
		const namespaceImport = declaration.getNamespaceImport();
		if (namespaceImport && namespaceImport.getText() === localName) {
			return { specifier, exportedName: "*" };
		}
		for (const named of declaration.getNamedImports()) {
			const alias = named.getAliasNode();
			const local = alias ? alias.getText() : named.getName();
			if (local === localName) {
				return { specifier, exportedName: named.getName() };
			}
		}
	}
	return undefined;
}

function classifyDeclaration(node: Node): RefKind {
	if (Node.isClassDeclaration(node) || Node.isClassExpression(node)) {
		return "class";
	}
	if (
		Node.isFunctionDeclaration(node) ||
		Node.isArrowFunction(node) ||
		Node.isFunctionExpression(node)
	) {
		return "function";
	}
	if (Node.isVariableDeclaration(node)) {
		return "variable";
	}
	return "other";
}

function localDeclaration(
	sourceFile: SourceFile,
	name: string,
): Node | undefined {
	return (
		sourceFile.getClass(name) ??
		sourceFile.getFunction(name) ??
		sourceFile.getVariableDeclaration(name) ??
		sourceFile.getEnum(name)
	);
}

function resolveDefaultExport(
	project: Project,
	sourceFile: SourceFile,
	hops: number,
): ResolvedRef | undefined {
	for (const declaration of sourceFile.getClasses()) {
		if (hasDefaultKeyword(declaration)) {
			return asResolved(declaration, sourceFile, declaration.getName());
		}
	}
	for (const declaration of sourceFile.getFunctions()) {
		if (hasDefaultKeyword(declaration)) {
			return asResolved(declaration, sourceFile, declaration.getName());
		}
	}
	for (const assignment of sourceFile.getExportAssignments()) {
		if (assignment.isExportEquals()) {
			continue;
		}
		const expression = assignment.getExpression();
		if (Node.isIdentifier(expression)) {
			const local = localDeclaration(sourceFile, expression.getText());
			if (local) {
				return asResolved(local, sourceFile, expression.getText());
			}
			const viaImport = resolveThroughImport(
				project,
				sourceFile,
				expression.getText(),
				hops,
			);
			if (viaImport?.resolved) {
				return viaImport;
			}
		}
		if (Node.isClassExpression(expression)) {
			return asResolved(expression, sourceFile, expression.getName());
		}
		// `export default () => <div/>` / `export default function () {}`.
		if (Node.isArrowFunction(expression)) {
			return asResolved(expression, sourceFile, undefined);
		}
		if (Node.isFunctionExpression(expression)) {
			return asResolved(expression, sourceFile, expression.getName());
		}
	}
	// `export { X as default }` and `export { default } from "./X"`.
	for (const declaration of sourceFile.getExportDeclarations()) {
		const moduleSpecifier = declaration.getModuleSpecifierValue();
		for (const specifier of declaration.getNamedExports()) {
			const alias = specifier.getAliasNode();
			const exposed = alias ? alias.getText() : specifier.getName();
			if (exposed !== "default") {
				continue;
			}
			const target = moduleSpecifier
				? (resolveModuleSpecifier(project, sourceFile, moduleSpecifier) ??
					sourceFile)
				: sourceFile;
			// `export { default }` with no module specifier would recurse forever.
			if (target === sourceFile && specifier.getName() === "default") {
				continue;
			}
			const resolved = resolveExportedName(
				project,
				target,
				specifier.getName(),
				hops - 1,
			);
			if (resolved?.resolved) {
				return resolved;
			}
			if (!moduleSpecifier) {
				// `import { Card } from "./Card"; export { Card as default };` — the
				// barrel's default export is an *imported* binding, so the lookup
				// above searched this file for a declaration that was never here.
				// Left unresolved, every default import of the barrel stops the
				// component walk at a boundary and turns a control reference dynamic.
				const viaImport = resolveThroughImport(
					project,
					sourceFile,
					specifier.getName(),
					hops - 1,
				);
				if (viaImport?.resolved) {
					return viaImport;
				}
			}
		}
	}
	return undefined;
}

function asResolved(
	declaration: Node,
	sourceFile: SourceFile,
	name: string | undefined,
): ResolvedRef {
	return {
		resolved: true,
		kind: classifyDeclaration(declaration),
		name: name ?? "default",
		declaration,
		sourceFile,
	};
}

/** Looks up `exportName` in `sourceFile`, following re-export hops. */
export function resolveExportedName(
	project: Project,
	sourceFile: SourceFile,
	exportName: string,
	hops = DEFAULT_HOPS,
): ResolvedRef | undefined {
	if (hops < 0) {
		return undefined;
	}
	if (exportName === "default") {
		return resolveDefaultExport(project, sourceFile, hops);
	}

	const local = localDeclaration(sourceFile, exportName);
	if (local) {
		return asResolved(local, sourceFile, exportName);
	}

	for (const declaration of sourceFile.getExportDeclarations()) {
		const specifier = declaration.getModuleSpecifierValue();
		const namedExports = declaration.getNamedExports();

		if (namedExports.length > 0) {
			for (const named of namedExports) {
				const alias = named.getAliasNode();
				const exposed = alias ? alias.getText() : named.getName();
				if (exposed !== exportName) {
					continue;
				}
				if (!specifier) {
					// `class Card {}; export { Card as CheckoutCard };` — the alias is
					// what the importer asks for, but the declaration carries the
					// pre-alias name, so the local lookup at the top of this function
					// (which used the alias) found nothing. Try the declared name before
					// assuming the binding must have come from an import: treating a
					// locally declared class as unresolved turns imported components
					// into tree boundaries and page-object references into dynamic ones.
					const localAlias = localDeclaration(sourceFile, named.getName());
					if (localAlias) {
						return asResolved(localAlias, sourceFile, named.getName());
					}
					// `import { Card } from "./Card"; export { Card };` — a local
					// re-export of an imported binding. Recursing into this same file
					// would just re-run the failed local lookup.
					const viaImport = resolveThroughImport(
						project,
						sourceFile,
						named.getName(),
						hops - 1,
					);
					if (viaImport?.resolved) {
						return viaImport;
					}
					continue;
				}
				const target = resolveModuleSpecifier(project, sourceFile, specifier);
				if (!target) {
					return undefined;
				}
				const resolved = resolveExportedName(
					project,
					target,
					named.getName(),
					hops - 1,
				);
				if (resolved) {
					return resolved;
				}
			}
			continue;
		}

		// `export * from "./x"`
		if (specifier) {
			const target = resolveModuleSpecifier(project, sourceFile, specifier);
			if (target && target !== sourceFile) {
				const resolved = resolveExportedName(
					project,
					target,
					exportName,
					hops - 1,
				);
				if (resolved) {
					return resolved;
				}
			}
		}
	}

	// Fall back to a non-exported local declaration: an intermediate base class
	// does not have to be exported to be part of the inheritance chain.
	const anyLocal = sourceFile
		.getClasses()
		.find((declaration) => declaration.getName() === exportName);
	return anyLocal ? asResolved(anyLocal, sourceFile, exportName) : undefined;
}

function resolveThroughImport(
	project: Project,
	sourceFile: SourceFile,
	localName: string,
	hops: number,
): RefResolution | undefined {
	const binding = findImportBinding(sourceFile, localName);
	if (!binding) {
		return undefined;
	}
	const target = resolveModuleSpecifier(project, sourceFile, binding.specifier);
	if (!target) {
		// A bare specifier that maps nowhere and links to no workspace package is
		// a real dependency.
		if (!isRelativeSpecifier(binding.specifier)) {
			// One exception worth naming: a first-party package whose only
			// resolvable entry is compiled output. "External dependency" is the
			// wrong thing to tell an agent about code in its own repository.
			const probed = probeWorkspacePackage(
				project,
				sourceFile,
				binding.specifier,
			);
			return {
				resolved: false,
				external: true,
				module:
					probed.kind === "built-output"
						? `${binding.specifier} (built output)`
						: binding.specifier,
				name: binding.exportedName === "*" ? localName : binding.exportedName,
			};
		}
		return {
			resolved: false,
			external: false,
			name: localName,
			reason: "identifier-unresolved",
		};
	}
	if (binding.exportedName === "*") {
		return {
			resolved: false,
			external: false,
			name: localName,
			reason: "unsupported-syntax",
		};
	}
	const resolved = resolveExportedName(
		project,
		target,
		binding.exportedName,
		hops,
	);
	return (
		resolved ?? {
			resolved: false,
			external: false,
			name: localName,
			reason: "identifier-unresolved",
		}
	);
}

/** A scope that can hold exported declarations: a module file or a `namespace`. */
type ExportScope = SourceFile | ModuleDeclaration;

/**
 * Follows one namespace segment: `export * as seg from "./x"` in a module, or a
 * `namespace seg {}` declaration in either kind of scope.
 */
function namespaceHop(
	project: Project,
	scope: ExportScope,
	segment: string,
): ExportScope | undefined {
	if (Node.isSourceFile(scope)) {
		for (const declaration of scope.getExportDeclarations()) {
			if (declaration.getNamespaceExport()?.getName() !== segment) {
				continue;
			}
			const specifier = declaration.getModuleSpecifierValue();
			const target = specifier
				? resolveModuleSpecifier(project, scope, specifier)
				: undefined;
			if (target) {
				return target;
			}
		}
	}
	return scope.getModule(segment);
}

/** Looks a name up inside a `namespace` body, mirroring {@link localDeclaration}. */
function moduleMember(
	scope: ModuleDeclaration,
	name: string,
): Node | undefined {
	return (
		scope.getClass(name) ??
		scope.getFunction(name) ??
		scope.getVariableDeclaration(name) ??
		scope.getEnum(name)
	);
}

/**
 * `ns.Member`, including nested chains such as `pages.controls.Button`.
 *
 * Without this, `new pages.HomePage(page)` and `class X extends po.PageObject`
 * lose the qualifier before resolution and are reported as unresolvable, even
 * though the namespace form is fully static. Each leading segment is one
 * namespace hop — a `export * as x from` re-export or a `namespace x {}` — and
 * a chain that cannot be walked is reported as unsupported rather than quietly
 * dropping the reference.
 */
function resolveNamespaceMember(
	project: Project,
	sourceFile: SourceFile,
	namespaceName: string,
	memberPath: string[],
	hops: number,
): RefResolution {
	const memberName = memberPath[memberPath.length - 1];
	const unresolved: UnresolvedRef = {
		resolved: false,
		external: false,
		name: memberName,
		reason: "identifier-unresolved",
	};
	const binding = findImportBinding(sourceFile, namespaceName);
	let scope: ExportScope | undefined;
	if (binding?.exportedName === "*") {
		const target = resolveModuleSpecifier(
			project,
			sourceFile,
			binding.specifier,
		);
		if (!target) {
			if (!isRelativeSpecifier(binding.specifier)) {
				return {
					resolved: false,
					external: true,
					module: binding.specifier,
					name: memberName,
				};
			}
			return unresolved;
		}
		scope = target;
	} else if (!binding) {
		// `namespace pages { … }` declared right here in the file.
		scope = sourceFile.getModule(namespaceName);
	}
	if (!scope) {
		return unresolved;
	}

	for (const segment of memberPath.slice(0, -1)) {
		const next = namespaceHop(project, scope, segment);
		if (!next) {
			return {
				resolved: false,
				external: false,
				name: memberName,
				reason: "unsupported-syntax",
			};
		}
		scope = next;
	}

	if (Node.isSourceFile(scope)) {
		return resolveExportedName(project, scope, memberName, hops) ?? unresolved;
	}
	const declaration = moduleMember(scope, memberName);
	return declaration
		? asResolved(declaration, scope.getSourceFile(), memberName)
		: unresolved;
}

/**
 * Syntax-first identifier resolution.
 *
 * 1. Local declaration in the same file.
 * 2. Import declaration in the same file, resolved by hand against the
 *    filesystem (relative specifiers only).
 * 3. Type-checker fallback, and only then — instantiating the checker is the
 *    single most expensive thing this engine can do.
 */
export function resolveIdentifier(
	project: Project,
	sourceFile: SourceFile,
	localName: string,
	options: ResolveOptions = {},
): RefResolution {
	const hops = options.maxHops ?? DEFAULT_HOPS;

	const dot = localName.indexOf(".");
	if (dot > 0) {
		const segments = localName.split(".");
		return resolveNamespaceMember(
			project,
			sourceFile,
			segments[0],
			segments.slice(1),
			hops,
		);
	}

	const local = localDeclaration(sourceFile, localName);
	if (local) {
		return asResolved(local, sourceFile, localName);
	}

	const viaImport = resolveThroughImport(project, sourceFile, localName, hops);
	if (viaImport) {
		return viaImport;
	}

	if (options.preferSyntacticResolution === false) {
		return checkerFallback(project, sourceFile, localName);
	}

	return {
		resolved: false,
		external: false,
		name: localName,
		reason: "identifier-unresolved",
	};
}

function checkerFallback(
	project: Project,
	sourceFile: SourceFile,
	localName: string,
): RefResolution {
	const identifier = sourceFile
		.getDescendantsOfKind(SyntaxKind.Identifier)
		.find((node) => node.getText() === localName);
	if (identifier) {
		for (const definition of identifier.getDefinitionNodes()) {
			const definitionFile = definition.getSourceFile();
			if (!isWorkspaceLocal(project, definitionFile.getFilePath())) {
				continue;
			}
			return asResolved(definition, definitionFile, localName);
		}
	}
	return {
		resolved: false,
		external: false,
		name: localName,
		reason: "identifier-unresolved",
	};
}

/**
 * Resolves the class an identifier refers to, rejecting anything that is not a
 * class declaration (a function of the same name is not a page object).
 */
export function resolveClassRef(
	project: Project,
	sourceFile: SourceFile,
	localName: string,
	options?: ResolveOptions,
): RefResolution {
	const resolution = resolveIdentifier(project, sourceFile, localName, options);
	if (resolution.resolved && resolution.kind !== "class") {
		// A variable holding a class expression still counts.
		if (Node.isVariableDeclaration(resolution.declaration)) {
			const initializer = resolution.declaration.getInitializer();
			if (initializer && Node.isClassExpression(initializer)) {
				return asResolved(initializer, resolution.sourceFile, resolution.name);
			}
		}
	}
	return resolution;
}

/** True when the identifier resolves to something callable as a factory. */
export function resolvesToCallable(resolution: RefResolution): boolean {
	if (!resolution.resolved) {
		return false;
	}
	if (resolution.kind === "class" || resolution.kind === "function") {
		return true;
	}
	if (Node.isVariableDeclaration(resolution.declaration)) {
		const initializer = resolution.declaration.getInitializer();
		return (
			!!initializer &&
			(Node.isArrowFunction(initializer) ||
				Node.isFunctionExpression(initializer) ||
				Node.isClassExpression(initializer))
		);
	}
	return false;
}
