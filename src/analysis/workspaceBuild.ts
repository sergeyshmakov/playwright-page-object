import * as path from "node:path";
import { Project } from "ts-morph";
import type { ConfigDiscovery } from "./config/configDiscovery";
import { readPlaywrightConfig } from "./config/playwrightConfig";
import {
	defaultExcludeGlobs,
	defaultIncludeGlobs,
	locateTsConfig,
	SCAN_GLOB,
	synthesizedCompilerOptions,
	tsConfigFileNames,
} from "./config/tsconfig";
import { AnalysisLimitError, info } from "./diagnostics";
import type { Diagnostic } from "./types";
import { toPosix, toPosixRelative } from "./util/paths";
import type { Workspace, WorkspaceOptions } from "./workspace";
import {
	absoluteGlob,
	countsAgainstCap,
	isAnalysable,
	normalizeRoot,
	scopeExcludeGlobs,
} from "./workspaceScope";

/**
 * Building the project one workspace analyses.
 *
 * Everything here runs before a `Workspace` exists and never again: the file
 * set, the compiler options and the cap that governs both are fixed at
 * construction, and the mtime sweep that keeps a live workspace current cannot
 * revisit any of them. That is why an edited `testDir` rebuilds rather than
 * refreshes.
 */

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
export const DEFAULT_MAX_FILES = 8000;

/**
 * Playwright's implicit `testDir`: the directory the config file sits in.
 *
 * `configFile` is workspace-relative, so a root-level config yields `"."` — the
 * project root, which {@link locateTsConfig} has already checked by the time it
 * looks at the test dir. Returning `undefined` for that case keeps the walk from
 * re-stating a path it just rejected.
 */
export function configDirOf(configFile: string | null): string | undefined {
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
 * What a new workspace's `Project` will hold, before anything holds it.
 *
 * The `Project` is already open by the time this is returned - opening it *is*
 * the decision, because which tsconfig supplies the compiler options and which
 * globs are added are the same choice. `warnings` are the notes that choice
 * produced, handed back rather than pushed, because the workspace they belong
 * to does not exist yet.
 */
export interface ProjectPlan {
	project: Project;
	tsconfigPath: string | null;
	discovery: ConfigDiscovery;
	warnings: Diagnostic[];
}

/**
 * Decides what a new workspace analyses: which Playwright config governs it,
 * which tsconfig that implies, and which files land in the `Project`.
 *
 * Split out of `Workspace` because none of it is state of a live workspace -
 * it runs once, before there is one, and every question it answers was settled
 * by the time the constructor returns.
 *
 * `probeWith` exists because the Playwright config has to be read from a
 * throwaway project before the real one can be built, and reading it needs a
 * `Workspace`, whose constructor is private. Handing the construction back to
 * `workspace.ts` keeps it that way; the alternative is a public constructor,
 * which would let a caller skip the scope normalisation done at the boundary.
 */
export function planProject(
	options: WorkspaceOptions,
	probeWith: (project: Project) => Workspace,
): ProjectPlan {
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
	const probeWorkspace = probeWith(probe);
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

	return { project, tsconfigPath: located.path, discovery, warnings };
}
