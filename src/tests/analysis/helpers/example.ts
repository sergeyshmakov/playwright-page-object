import * as path from "node:path";
import { Project, ts } from "ts-morph";
import { toPosix } from "../../../analysis/util/paths";
import { Workspace } from "../../../analysis/workspace";

/** Absolute path of the demo app that ships with the repository. */
export const EXAMPLE_ROOT = path.resolve(process.cwd(), "example");

/** Absolute path of the repository root. */
export const REPO_ROOT = path.resolve(process.cwd());

let cached: Workspace | null = null;

/**
 * Workspace over the real `example/` sources.
 *
 * Files are added with explicit globs and inline compiler options rather than
 * through `example/tsconfig.json`: the app's build config may drift, and it
 * excludes `playwright.config.ts`, which the engine has to read.
 */
export function exampleWorkspace(): Workspace {
	if (cached) {
		return cached;
	}
	const root = toPosix(EXAMPLE_ROOT);
	const project = new Project({
		skipAddingFilesFromTsConfig: true,
		skipFileDependencyResolution: true,
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			jsx: ts.JsxEmit.ReactJSX,
			strict: true,
			noEmit: true,
			skipLibCheck: true,
		},
	});
	project.addSourceFilesAtPaths([
		`${root}/e2e/**/*.ts`,
		`${root}/src/**/*.tsx`,
		`!${root}/**/node_modules/**`,
	]);
	cached = Workspace.fromProject(
		project,
		{ projectRoot: EXAMPLE_ROOT },
		{ inMemory: false },
	);
	return cached;
}
