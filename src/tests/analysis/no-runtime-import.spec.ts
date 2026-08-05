import * as path from "node:path";
import { Project, ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import { toPosix, toPosixRelative } from "../../analysis/util/paths";
import {
	isRelativeSpecifier,
	resolveRelativeModule,
} from "../../analysis/util/resolve";
import { REPO_ROOT } from "./helpers/example";

/**
 * Packaging guard, dogfooded with ts-morph.
 *
 * `ts-morph` is a real runtime dependency, so the shipped entry point must
 * never be able to reach it: `src/index.ts` is the zero-dependency library
 * bundle, and only the analysis/MCP entry points may pull the analyser in.
 */
function repoProject(): Project {
	const root = toPosix(REPO_ROOT);
	const project = new Project({
		skipAddingFilesFromTsConfig: true,
		skipFileDependencyResolution: true,
		skipLoadingLibFiles: true,
		compilerOptions: { target: ts.ScriptTarget.ES2022, noEmit: true },
	});
	project.addSourceFilesAtPaths([
		`${root}/src/**/*.ts`,
		`!${root}/**/node_modules/**`,
	]);
	return project;
}

const ANALYSIS_OR_MCP = /^src\/(analysis|mcp)\//;

describe("ts-morph import boundary", () => {
	const project = repoProject();

	it("is imported only from src/analysis/** and src/mcp/**", () => {
		const offenders: string[] = [];
		for (const sourceFile of project.getSourceFiles()) {
			const rel = toPosixRelative(REPO_ROOT, sourceFile.getFilePath());
			if (ANALYSIS_OR_MCP.test(rel) || rel.startsWith("src/tests/")) {
				continue;
			}
			for (const declaration of sourceFile.getImportDeclarations()) {
				const specifier = declaration.getModuleSpecifierValue();
				if (specifier === "ts-morph" || specifier.startsWith("ts-morph/")) {
					offenders.push(rel);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("is unreachable from the src/index.ts import graph", () => {
		const entry = project.getSourceFileOrThrow(
			path.join(REPO_ROOT, "src", "index.ts"),
		);
		const visited = new Set<string>();
		const reached: string[] = [];

		const walk = (file: ReturnType<Project["getSourceFileOrThrow"]>) => {
			const key = file.getFilePath();
			if (visited.has(key)) {
				return;
			}
			visited.add(key);
			const rel = toPosixRelative(REPO_ROOT, key);
			if (ANALYSIS_OR_MCP.test(rel)) {
				reached.push(rel);
			}
			for (const declaration of [
				...file.getImportDeclarations(),
				...file.getExportDeclarations(),
			]) {
				const specifier = declaration.getModuleSpecifierValue();
				if (!specifier) {
					continue;
				}
				if (specifier === "ts-morph") {
					reached.push(`${rel} -> ts-morph`);
					continue;
				}
				if (!isRelativeSpecifier(specifier)) {
					continue;
				}
				const target = resolveRelativeModule(project, file, specifier);
				if (target) {
					walk(target);
				}
			}
		};

		walk(entry);
		expect(reached).toEqual([]);
		// Sanity check: the walk really did traverse the library.
		expect(visited.size).toBeGreaterThan(3);
	});

	it("does reach ts-morph from the analysis barrel, proving the walk works", () => {
		const barrel = project.getSourceFileOrThrow(
			path.join(REPO_ROOT, "src", "analysis", "index.ts"),
		);
		const specifiers = new Set<string>();
		const visited = new Set<string>();
		const walk = (file: ReturnType<Project["getSourceFileOrThrow"]>) => {
			if (visited.has(file.getFilePath())) {
				return;
			}
			visited.add(file.getFilePath());
			for (const declaration of [
				...file.getImportDeclarations(),
				...file.getExportDeclarations(),
			]) {
				const specifier = declaration.getModuleSpecifierValue();
				if (!specifier) {
					continue;
				}
				specifiers.add(specifier);
				if (isRelativeSpecifier(specifier)) {
					const target = resolveRelativeModule(project, file, specifier);
					if (target) {
						walk(target);
					}
				}
			}
		};
		walk(barrel);
		expect(specifiers.has("ts-morph")).toBe(true);
	});
});
