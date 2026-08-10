import * as fs from "node:fs";
import * as path from "node:path";
// Deep import, and deliberately so: this module runs before the server exists
// and must not pull the analysis barrel's ts-morph graph in with it, but the
// question "is this a glob?" has exactly one right answer per repository and it
// belongs to the matcher that will read the pattern next. `util/paths` imports
// `node:path` and `picomatch`, nothing else — `src/tests/analysis/
// no-runtime-import.spec.ts` holds that shut.
import { isGlobPattern } from "../analysis/util/paths";

/** Runtime options resolved from CLI flags (see src/cli.ts). */
export interface McpServerOptions {
	/** Repository root to analyze. Defaults to process.cwd() at the CLI layer. */
	projectRoot: string;
	/** Explicit tsconfig.json path; otherwise discovered by the engine. */
	tsconfig?: string;
	/**
	 * Explicit `playwright.config.*` path. Skips discovery entirely, including
	 * the sibling-config probe: the named file is the config, or there is none.
	 */
	playwrightConfig?: string;
	/** Restrict scanning to these directories (repeatable --src-dir flag). */
	srcDirs?: string[];
	/** Test-id attribute override (--attribute flag beats playwright.config). */
	attribute?: string;
	/** Cap on files parsed. */
	maxFiles?: number;
	/**
	 * Count a test id written on a component tag as rendered, for repositories
	 * whose components forward props as a rule (`--assume-forwarded`).
	 *
	 * A server-level switch rather than a tool argument: it changes what the word
	 * "rendered" means in every answer, and that has to be a property of the
	 * repository the server was started against, not of one call.
	 */
	assumeForwarded?: boolean;
}

/**
 * Checks the paths a server was started with, before any analysis runs.
 *
 * Every one of these mistakes is silent at runtime: a mistyped `--project-root`
 * analyses an empty directory, a mistyped `--src-dir` narrows the scope to
 * nothing, and a mistyped `--playwright-config` used to fall back to discovery
 * and answer with a different file's attribute. A long-lived stdio server then
 * serves that wrong answer to every call for the rest of the session, so the
 * cheapest possible fix is to refuse to start.
 *
 * Deliberately free of any `src/analysis` import: this runs on the CLI's startup
 * path, where pulling in ts-morph to stat four paths would be the slowest thing
 * the process does.
 */
export function validateServerOptions(options: McpServerOptions): string[] {
	const problems: string[] = [];
	const root = path.resolve(options.projectRoot);

	if (!isDirectory(root)) {
		problems.push(`--project-root is not a directory: ${options.projectRoot}`);
	}
	if (options.tsconfig !== undefined) {
		const resolved = resolveAgainst(root, options.tsconfig);
		if (!isFile(resolved)) {
			problems.push(`--tsconfig is not a file: ${options.tsconfig}`);
		}
	}
	if (options.playwrightConfig !== undefined) {
		const resolved = resolveAgainst(root, options.playwrightConfig);
		if (!isFile(resolved)) {
			problems.push(
				`--playwright-config is not a file: ${options.playwrightConfig}`,
			);
		}
	}
	for (const dir of options.srcDirs ?? []) {
		// A glob is checked by matching it, not by stat'ing it, and a `!` prefix is
		// an exclusion whose target legitimately may not exist. The verdict comes
		// from picomatch, so an extglob without a `*` in it — `src/@(App|Admin).tsx`
		// — is not mistaken for a plain path and refused for not existing.
		if (dir.startsWith("!") || isGlobPattern(dir)) {
			continue;
		}
		const resolved = resolveAgainst(root, dir);
		// The analysis drops every path outside the root before it counts anything,
		// so a scope that lands outside contributes no file at all: the server would
		// start, every tool would answer with an empty index, and nothing would say
		// why. A relative value resolves against the root and is inside it unless it
		// climbs out with `..`; an absolute one inside the root is fine.
		if (!isInside(root, resolved)) {
			problems.push(`--src-dir is outside --project-root: ${dir}`);
			continue;
		}
		if (!exists(resolved)) {
			problems.push(`--src-dir does not exist: ${dir}`);
		}
	}

	return problems;
}

function resolveAgainst(root: string, candidate: string): string {
	return path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
}

/**
 * Whether a resolved path is the root or sits under it.
 *
 * `path.relative` rather than a string prefix: it normalises `..` segments and
 * handles the Windows case where the two paths are on different drives (it
 * answers with an absolute path then).
 */
function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	);
}

function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

function isFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

function exists(candidate: string): boolean {
	try {
		fs.statSync(candidate);
		return true;
	} catch {
		return false;
	}
}
