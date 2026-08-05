import * as fs from "node:fs";
import * as path from "node:path";
import type { CompilerOptions } from "ts-morph";
import { ts } from "ts-morph";
import { toPosix } from "../util/paths";

export interface TsConfigLocation {
	/** Absolute path, or `null` when nothing usable was found. */
	path: string | null;
	source: "explicit" | "project-root" | "test-dir" | "none";
}

function existsFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

/**
 * Finds the tsconfig that best describes the project under analysis.
 *
 * Order: explicit option, `<projectRoot>/tsconfig.json`, then the nearest
 * `tsconfig.json` walking up from the Playwright `testDir` (a monorepo often
 * keeps the e2e tsconfig next to the specs rather than at the repo root).
 */
export function locateTsConfig(
	projectRoot: string,
	explicit?: string,
	testDir?: string,
): TsConfigLocation {
	if (explicit) {
		const absolute = path.isAbsolute(explicit)
			? explicit
			: path.resolve(projectRoot, explicit);
		if (existsFile(absolute)) {
			return { path: absolute, source: "explicit" };
		}
		return { path: null, source: "none" };
	}

	const atRoot = path.join(projectRoot, "tsconfig.json");
	if (existsFile(atRoot)) {
		return { path: atRoot, source: "project-root" };
	}

	if (testDir) {
		let current = path.resolve(projectRoot, testDir);
		for (let hop = 0; hop < 6; hop += 1) {
			const candidate = path.join(current, "tsconfig.json");
			if (existsFile(candidate)) {
				return { path: candidate, source: "test-dir" };
			}
			const parent = path.dirname(current);
			if (parent === current) {
				break;
			}
			current = parent;
		}
	}

	return { path: null, source: "none" };
}

/**
 * Compiler options used when no tsconfig exists. Everything the engine needs is
 * syntactic, so these only have to make the parser produce the right AST.
 */
export function synthesizedCompilerOptions(): CompilerOptions {
	return {
		target: ts.ScriptTarget.ES2022,
		jsx: ts.JsxEmit.ReactJSX,
		allowJs: false,
		noEmit: true,
		skipLibCheck: true,
		strict: false,
	};
}

/** Default globs used when the workspace has no tsconfig to enumerate files. */
export function defaultIncludeGlobs(projectRoot: string): string[] {
	const root = toPosix(projectRoot).replace(/\/$/, "");
	return [
		`${root}/**/*.ts`,
		`${root}/**/*.tsx`,
		`${root}/**/*.mts`,
		`${root}/**/*.cts`,
	];
}

export function defaultExcludeGlobs(projectRoot: string): string[] {
	const root = toPosix(projectRoot).replace(/\/$/, "");
	return [
		`!${root}/**/node_modules/**`,
		`!${root}/**/dist/**`,
		`!${root}/**/build/**`,
		`!${root}/**/coverage/**`,
		`!${root}/**/playwright-report/**`,
		`!${root}/**/test-results/**`,
	];
}
