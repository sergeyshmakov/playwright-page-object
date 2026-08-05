import * as fs from "node:fs";
import * as path from "node:path";
import type { Decorator, Project, SourceFile } from "ts-morph";
import type { Diagnostic } from "../types";
import { isRelativeSpecifier, type ResolveOptions } from "../util/resolve";
import type { Workspace } from "../workspace";

export const LIBRARY_PACKAGE = "playwright-page-object";

/** Class decorators that install a root locator (`rootSelectors.ts`). */
export const ROOT_DECORATORS = new Set([
	"ListRootSelector",
	"RootSelector",
	"RootSelectorByAltText",
	"RootSelectorByLabel",
	"RootSelectorByPlaceholder",
	"RootSelectorByRole",
	"RootSelectorByText",
	"RootSelectorByTitle",
]);

/** Accessor decorators that install a child locator (`selectors.ts`). */
export const MEMBER_DECORATORS = new Set([
	"ListSelector",
	"Selector",
	"SelectorBy",
	"SelectorByAltText",
	"SelectorByLabel",
	"SelectorByPlaceholder",
	"SelectorByRole",
	"SelectorByText",
	"SelectorByTitle",
]);

export const LIBRARY_BASE_CLASSES = new Set([
	"PageObject",
	"ListPageObject",
	"RootPageObject",
]);

export const CANONICAL_EXPORTS = new Set<string>([
	...ROOT_DECORATORS,
	...MEMBER_DECORATORS,
	...LIBRARY_BASE_CLASSES,
	"createFixtures",
]);

/**
 * Decorators whose factory argument is positionally fixed at index 1.
 *
 * `Selector(id?, factory?)`, `SelectorByText(text, factory?)` and
 * `ListSelector(mask, factory?)` are declared with fixed arity, so the runtime
 * never applies the `typeof lastArg === "function"` test to them.
 */
export const FIXED_ARITY_DECORATORS = new Set([
	"Selector",
	"SelectorByText",
	"ListSelector",
]);

/**
 * Variadic decorators forward `...args` to the matching `getBy*` call and pick
 * the factory off the end with a runtime `typeof` test (`selectors.ts:128-131`).
 */
export const VARIADIC_DECORATORS = new Set([
	"SelectorByRole",
	"SelectorByLabel",
	"SelectorByPlaceholder",
	"SelectorByAltText",
	"SelectorByTitle",
]);

export interface LibraryImports {
	/** Local binding name to canonical library export name. */
	aliases: Map<string, string>;
	/** Local names bound by `import * as ns from "playwright-page-object"`. */
	namespaces: Set<string>;
	hasAny: boolean;
}

/**
 * Shared configuration threaded through every page-object extractor.
 *
 * `warnings` is a sink: extractors append to it instead of throwing, which is
 * what keeps the public API "never fails on user data".
 */
export interface AnalysisContext {
	ws: Workspace;
	project: Project;
	libraryModules: string[];
	/**
	 * Whether a *relative* import of a canonical export counts as the library.
	 * True when the analysed repo is `playwright-page-object` itself.
	 */
	acceptRelative: boolean;
	resolveOptions: ResolveOptions;
	warnings: Diagnostic[];
}

const libraryRepoCache = new Map<string, boolean>();

/** True when `projectRoot` is the `playwright-page-object` package itself. */
export function isLibraryRepo(projectRoot: string): boolean {
	const cached = libraryRepoCache.get(projectRoot);
	if (cached !== undefined) {
		return cached;
	}
	let result = false;
	try {
		const raw = fs.readFileSync(path.join(projectRoot, "package.json"), "utf8");
		result = (JSON.parse(raw) as { name?: string }).name === LIBRARY_PACKAGE;
	} catch {
		result = false;
	}
	libraryRepoCache.set(projectRoot, result);
	return result;
}

export function createAnalysisContext(
	ws: Workspace,
	overrides?: Partial<AnalysisContext>,
): AnalysisContext {
	return {
		ws,
		project: ws.project,
		libraryModules: ws.options.libraryModules ?? [LIBRARY_PACKAGE],
		acceptRelative: isLibraryRepo(ws.root),
		resolveOptions: {
			preferSyntacticResolution: ws.options.preferSyntacticResolution ?? true,
		},
		warnings: [],
		...overrides,
	};
}

function isLibrarySpecifier(specifier: string, ctx: AnalysisContext): boolean {
	for (const module of ctx.libraryModules) {
		if (specifier === module || specifier.startsWith(`${module}/`)) {
			return true;
		}
	}
	return ctx.acceptRelative && isRelativeSpecifier(specifier);
}

/**
 * Builds the local-name to canonical-name map for one file.
 *
 * Aliased imports (`import { Selector as S }`) are the whole reason this exists:
 * matching `@Selector` by text would miss `@S(...)` entirely.
 */
export function collectLibraryImports(
	sourceFile: SourceFile,
	ctx: AnalysisContext,
): LibraryImports {
	const aliases = new Map<string, string>();
	const namespaces = new Set<string>();

	for (const declaration of sourceFile.getImportDeclarations()) {
		const specifier = declaration.getModuleSpecifierValue();
		if (!isLibrarySpecifier(specifier, ctx)) {
			continue;
		}
		const namespaceImport = declaration.getNamespaceImport();
		if (namespaceImport) {
			namespaces.add(namespaceImport.getText());
		}
		for (const named of declaration.getNamedImports()) {
			const canonical = named.getName();
			if (!CANONICAL_EXPORTS.has(canonical)) {
				continue;
			}
			const alias = named.getAliasNode();
			aliases.set(alias ? alias.getText() : canonical, canonical);
		}
	}

	return {
		aliases,
		namespaces,
		hasAny: aliases.size > 0 || namespaces.size > 0,
	};
}

/** Canonical library name behind a decorator, or `undefined` if it is not ours. */
export function canonicalDecoratorName(
	decorator: Decorator,
	imports: LibraryImports,
): string | undefined {
	const fullName = decorator.getFullName();
	const dot = fullName.indexOf(".");
	if (dot > 0) {
		const namespace = fullName.slice(0, dot);
		const member = fullName.slice(dot + 1);
		if (imports.namespaces.has(namespace) && CANONICAL_EXPORTS.has(member)) {
			return member;
		}
		return undefined;
	}
	return imports.aliases.get(fullName);
}

/** Canonical library name behind a plain identifier reference. */
export function canonicalLocalName(
	localName: string,
	imports: LibraryImports,
): string | undefined {
	return imports.aliases.get(localName);
}
