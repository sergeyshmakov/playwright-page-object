import * as path from "node:path";
import type { CompilerOptions, Project, SourceFile } from "ts-morph";
import { admitAddedFile } from "./fileBudget";
import { foldPath, toPosix } from "./paths";

/**
 * Which file on disk a relative or `paths`-mapped specifier names.
 *
 * Split out of `resolve.ts`, which keeps the vocabulary a resolution is
 * reported in and the entry points that produce one.
 */

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
export function loadFromBase(
	project: Project,
	base: string,
): SourceFile | undefined {
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
export function mappedModuleBases(
	project: Project,
	specifier: string,
): string[] {
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
