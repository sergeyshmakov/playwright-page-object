import type { Project } from "ts-morph";
import {
	ignoredExcludeGlobs,
	isIgnoredPath,
	isOutsideRoot,
	toPosix,
	toPosixRelative,
} from "../util/paths";

/**
 * Finding the Playwright config in a repository whose shape nobody promised.
 *
 * The previous reader probed a fixed list of basenames in a fixed list of
 * directories (`<root>`, `<root>/{test,tests,e2e}`). A monorepo that keeps its
 * config at `playwright/playwright.base.config.ts` matched none of them, so the
 * reader reported "no config", `use.testIdAttribute` silently fell back to
 * `data-testid` on a `data-tid` codebase, and every tool answered confidently
 * with the wrong attribute. A bounded repository-wide search over Playwright's
 * own naming convention has no such blind spot.
 *
 * The search is deliberately a filesystem enumeration rather than a pass over
 * the scanned source set: configs live outside the tsconfig `include`, must be
 * found before the analysed project exists, and must not depend on `--src-dir`
 * narrowing the scope. It runs through `project.getFileSystem()` so an
 * in-memory project is searched the same way a real one is.
 */

/** Extensions Playwright accepts for a config file, in preference order. */
export const CONFIG_EXTENSIONS = [
	"ts",
	"mts",
	"cts",
	"js",
	"mjs",
	"cjs",
] as const;

/**
 * Playwright's own convention: the basename starts with `playwright` and ends
 * with `.config.<ext>`. That covers `playwright.config.ts`,
 * `playwright.base.config.ts`, `playwright-ct.config.ts` and the sharded
 * `playwright.ci.config.mts` shapes without matching every `*.config.*` in the
 * repository (vite, vitest, tailwind, eslint...). A config named something else
 * entirely is what `--playwright-config` is for.
 */
export const CONFIG_GLOB = `**/playwright*.config.{${CONFIG_EXTENSIONS.join(",")}}`;

/** Basename shape of anything {@link CONFIG_GLOB} can match. */
export const CONFIG_BASENAME_PATTERN = new RegExp(
	`^playwright[^/]*\\.config\\.(?:${CONFIG_EXTENSIONS.join("|")})$`,
	"i",
);

/**
 * How many ranked candidates are kept. A repository with more Playwright
 * configs than this is not one a longer list would help: the ranking already
 * put the plausible ones first, and the rest only cost tokens in a diagnostic.
 */
export const MAX_CONFIG_CANDIDATES = 20;

export interface ConfigDiscovery {
	/** Ranked absolute posix paths, best first. Capped at {@link MAX_CONFIG_CANDIDATES}. */
	candidates: string[];
	/** `true` when ranking dropped candidates to respect the cap. */
	truncated?: true;
}

/** True for a path whose basename is one Playwright would recognise. */
export function isPlaywrightConfigPath(filePath: string): boolean {
	const posix = toPosix(filePath);
	return CONFIG_BASENAME_PATTERN.test(posix.slice(posix.lastIndexOf("/") + 1));
}

/**
 * Every Playwright-shaped config under `root`, ranked.
 *
 * Never throws: a filesystem that refuses the glob leaves the caller with an
 * empty list and the ordinary "no config found" path, which is strictly better
 * than failing a tool call over config discovery.
 */
export function discoverPlaywrightConfigs(
	project: Project,
	root: string,
): ConfigDiscovery {
	const rootPosix = toPosix(root).replace(/\/+$/, "");
	let found: string[];
	try {
		found = [
			...project
				.getFileSystem()
				.globSync([
					`${rootPosix}/${CONFIG_GLOB}`,
					...ignoredExcludeGlobs(rootPosix),
				]),
		];
	} catch {
		return { candidates: [] };
	}

	// The negated globs prune the walk, but a filesystem host that ignores them
	// (or a symlink that re-enters an ignored directory) must not put a
	// `node_modules` config in front of the repository's own.
	const inside = found.filter((filePath) => {
		const relative = toPosixRelative(root, filePath);
		return !isOutsideRoot(relative) && !isIgnoredPath(relative);
	});

	return rankConfigDiscovery(root, inside);
}

interface RankedCandidate {
	absolute: string;
	/** 0 for `playwright.config.<ext>`, 1 for any other matching basename. */
	exact: number;
	depth: number;
	extension: number;
	relative: string;
}

/**
 * Orders config candidates by how likely each is to be *the* config.
 *
 * 1. `playwright.config.<ext>` exactly — the name the Playwright docs use, and
 *    the one a repository that also has variants means as its entry point.
 * 2. Fewer path segments: a root-level config outranks a nested one.
 * 3. Extension order, mirroring Playwright's own resolution preference.
 * 4. Lexicographic, so the result never depends on directory-read order.
 *
 * Exported and pure so the ordering can be tested without a filesystem.
 */
export function rankConfigCandidates(root: string, paths: string[]): string[] {
	return rankConfigDiscovery(root, paths).candidates;
}

function rankConfigDiscovery(root: string, paths: string[]): ConfigDiscovery {
	const seen = new Set<string>();
	const ranked: RankedCandidate[] = [];
	for (const raw of paths) {
		const absolute = toPosix(raw);
		if (seen.has(absolute)) {
			continue;
		}
		seen.add(absolute);
		const basename = absolute.slice(absolute.lastIndexOf("/") + 1);
		if (!CONFIG_BASENAME_PATTERN.test(basename)) {
			continue;
		}
		const relative = toPosixRelative(root, absolute);
		const extension = basename.slice(basename.lastIndexOf(".") + 1);
		ranked.push({
			absolute,
			relative,
			exact: /^playwright\.config\.[^.]+$/i.test(basename) ? 0 : 1,
			depth: relative.split("/").length,
			extension: extensionRank(extension),
		});
	}

	ranked.sort(
		(left, right) =>
			left.exact - right.exact ||
			left.depth - right.depth ||
			left.extension - right.extension ||
			(left.absolute < right.absolute
				? -1
				: left.absolute > right.absolute
					? 1
					: 0),
	);

	const candidates = ranked
		.slice(0, MAX_CONFIG_CANDIDATES)
		.map((entry) => entry.absolute);
	return ranked.length > MAX_CONFIG_CANDIDATES
		? { candidates, truncated: true }
		: { candidates };
}

function extensionRank(extension: string): number {
	const index = (CONFIG_EXTENSIONS as readonly string[]).indexOf(
		extension.toLowerCase(),
	);
	return index < 0 ? CONFIG_EXTENSIONS.length : index;
}
