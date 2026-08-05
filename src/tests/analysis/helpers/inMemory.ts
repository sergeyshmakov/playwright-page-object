import * as path from "node:path";
import {
	type ClassDeclaration,
	Node,
	Project,
	type SourceFile,
	ts,
} from "ts-morph";
import {
	type AnalysisContext,
	collectLibraryImports,
	createAnalysisContext,
	type LibraryImports,
} from "../../../analysis/page-objects/libraryImports";
import { toPosix } from "../../../analysis/util/paths";
import { Workspace, type WorkspaceOptions } from "../../../analysis/workspace";

/**
 * Root used by every in-memory fixture.
 *
 * `path.resolve` is applied up front so the in-memory file paths and the
 * workspace root agree on Windows, where `path.resolve("/project")` becomes
 * `C:\project`.
 */
export const MEMORY_ROOT = path.resolve("/ppo-fixture");
export const MEMORY_ROOT_POSIX = toPosix(MEMORY_ROOT);

export function memoryPath(relativePath: string): string {
	return `${MEMORY_ROOT_POSIX}/${relativePath.replace(/^\.?\//, "")}`;
}

/**
 * Builds a hermetic `Workspace` from fixture code held as strings.
 *
 * Fixtures are never real modules on disk and are never imported: they are
 * parsed as text, so the Vitest Babel decorator transform never sees them and
 * the `accessor` lowering is irrelevant to these tests.
 */
export function makeWorkspace(
	files: Record<string, string>,
	options: Partial<WorkspaceOptions> = {},
): Workspace {
	const project = new Project({
		useInMemoryFileSystem: true,
		skipAddingFilesFromTsConfig: true,
		skipFileDependencyResolution: true,
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			jsx: ts.JsxEmit.ReactJSX,
			strict: true,
			noEmit: true,
		},
	});
	for (const [relativePath, contents] of Object.entries(files)) {
		project.createSourceFile(memoryPath(relativePath), contents, {
			overwrite: true,
		});
	}
	return Workspace.fromProject(
		project,
		{ projectRoot: MEMORY_ROOT, ...options },
		{ inMemory: true },
	);
}

/** Convenience: a single-file workspace at `src/fixture.ts`. */
export function makeSingleFileWorkspace(
	code: string,
	fileName = "src/fixture.ts",
	options: Partial<WorkspaceOptions> = {},
): Workspace {
	return makeWorkspace({ [fileName]: code }, options);
}

/** The library import line every page-object fixture starts with. */
export function libImport(...names: string[]): string {
	return `import { ${names.join(", ")} } from "playwright-page-object";\n`;
}

export interface ClassFixture {
	ws: Workspace;
	ctx: AnalysisContext;
	sourceFile: SourceFile;
	imports: LibraryImports;
	cls: ClassDeclaration;
}

/** Parses fixture code and hands back the pieces the extractors need. */
export function classFixture(
	code: string,
	className: string,
	extraFiles: Record<string, string> = {},
	fileName = "src/fixture.ts",
): ClassFixture {
	const ws = makeWorkspace({ [fileName]: code, ...extraFiles });
	const sourceFile = ws.project.getSourceFileOrThrow(memoryPath(fileName));
	const ctx = createAnalysisContext(ws);
	const imports = collectLibraryImports(sourceFile, ctx);
	const cls = sourceFile.getClassOrThrow(className);
	return { ws, ctx, sourceFile, imports, cls };
}

/** First library selector decorator on a named member of a fixture class. */
export function memberDecorator(fixture: ClassFixture, memberName: string) {
	const member = fixture.cls
		.getMembers()
		.find((candidate) =>
			Node.hasName(candidate) ? candidate.getName() === memberName : false,
		);
	if (!member) {
		throw new Error(`No member "${memberName}" in fixture class`);
	}
	return member;
}
