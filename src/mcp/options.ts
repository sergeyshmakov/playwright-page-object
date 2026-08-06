import * as fs from "node:fs";
import * as path from "node:path";

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
}

/** Characters that make a `--src-dir` value a glob rather than a plain path. */
const GLOB_MAGIC = /[*?[\]{}]/;

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
		// an exclusion whose target legitimately may not exist.
		if (GLOB_MAGIC.test(dir) || dir.startsWith("!")) {
			continue;
		}
		if (!exists(resolveAgainst(root, dir))) {
			problems.push(`--src-dir does not exist: ${dir}`);
		}
	}

	return problems;
}

function resolveAgainst(root: string, candidate: string): string {
	return path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
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
