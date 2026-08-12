import * as fs from "node:fs";
import * as path from "node:path";
import type {
	Decorator,
	ImportDeclaration,
	Project,
	SourceFile,
} from "ts-morph";
import type { Diagnostic } from "../types";
import {
	isRelativeSpecifier,
	type ResolveOptions,
	resolveRelativeModule,
} from "../util/resolve";
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
 *
 * There is deliberately no set for the variadic half. Every other member
 * decorator forwards `...args` and picks the factory off the end with that
 * runtime test, and `decoratorArgs.ts` reads it as the fall-through case - so a
 * list of them would have to be edited to change nothing, which is worse than
 * having none.
 */
export const FIXED_ARITY_DECORATORS = new Set([
	"Selector",
	"SelectorByText",
	"ListSelector",
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

/** The package itself, by name. Says nothing about barrels or the repo's own sources. */
function isDirectLibrarySpecifier(
	specifier: string,
	ctx: AnalysisContext,
): boolean {
	for (const module of ctx.libraryModules) {
		if (specifier === module || specifier.startsWith(`${module}/`)) {
			return true;
		}
	}
	return false;
}

function isLibrarySpecifier(specifier: string, ctx: AnalysisContext): boolean {
	return (
		isDirectLibrarySpecifier(specifier, ctx) ||
		(ctx.acceptRelative && isRelativeSpecifier(specifier))
	);
}

/**
 * How many local re-export hops to follow looking for the library.
 *
 * Barrels nest — `./testing` re-exports `./testing/pom`, which re-exports the
 * package — but not deeply, and each hop is a module resolution.
 */
const MAX_BARREL_HOPS = 5;

/**
 * The canonical library export a local barrel publishes under `exported`.
 *
 * Re-exporting the library through one project module — `export { Selector }
 * from "playwright-page-object"` in `src/testing/pom.ts`, imported everywhere
 * as `from "../testing/pom"` — is a normal convention, and it used to defeat
 * discovery completely: the specifier is relative, so no name was recognised,
 * the decorator map came back empty, and every class in the repository
 * disappeared from `list_page_objects`, the trees and coverage at once.
 *
 * Only `export ... from` and `export *` are followed, plus the two-step
 * `import { X } from "the-library"; export { X };`. A barrel that renames on
 * the way out — `export { Selector as PomSelector }` — is still missed, because
 * finding it would mean resolving every relative import in the repository
 * rather than only those already naming a canonical export.
 */
function canonicalThroughBarrel(
	file: SourceFile,
	exported: string,
	ctx: AnalysisContext,
	seen: Set<string>,
): string | undefined {
	if (seen.size >= MAX_BARREL_HOPS || seen.has(file.getFilePath())) {
		return undefined;
	}
	seen.add(file.getFilePath());

	/** One hop: the library ends the walk, a relative module continues it. */
	const through = (specifier: string, inward: string): string | undefined => {
		if (isDirectLibrarySpecifier(specifier, ctx)) {
			return CANONICAL_EXPORTS.has(inward) ? inward : undefined;
		}
		const next = resolveRelativeModule(ctx.project, file, specifier);
		return next ? canonicalThroughBarrel(next, inward, ctx, seen) : undefined;
	};

	for (const declaration of file.getExportDeclarations()) {
		if (declaration.isTypeOnly()) {
			continue;
		}
		const specifier = declaration.getModuleSpecifierValue();
		const named = declaration.getNamedExports();
		if (named.length === 0) {
			// `export * as controls from "the-library"` also has no named exports,
			// and it publishes exactly one name — `controls`. Treating it as a plain
			// star export said the barrel re-exported `Selector`, so a *local*
			// export of that name elsewhere in the barrel would be read as the
			// library's decorator. Skipped rather than followed: what it binds is a
			// namespace, and this function answers with canonical names.
			if (declaration.getNamespaceExport()) {
				continue;
			}
			// `export * from "..."`: the name passes through unchanged.
			const found = specifier ? through(specifier, exported) : undefined;
			if (found) {
				return found;
			}
			continue;
		}
		for (const one of named) {
			if (one.isTypeOnly()) {
				continue;
			}
			const outward = (one.getAliasNode() ?? one.getNameNode()).getText();
			if (outward !== exported) {
				continue;
			}
			const inward = one.getName();
			// `export { X } from "..."`, or a bare `export { X }` re-publishing
			// something this file imported.
			const hop = specifier ?? importedFrom(file, inward);
			const found = hop ? through(hop, inward) : undefined;
			if (found) {
				return found;
			}
		}
	}
	return undefined;
}

/**
 * Adds any canonical names a relative import turns out to have come from the
 * library, following {@link canonicalThroughBarrel}.
 *
 * The `CANONICAL_EXPORTS` test on the *imported* name is what keeps this cheap:
 * a repository's ordinary relative imports are dismissed without resolving
 * anything, and only a name that could be ours pays for a module load.
 */
function collectThroughBarrel(
	sourceFile: SourceFile,
	declaration: ImportDeclaration,
	ctx: AnalysisContext,
	aliases: Map<string, string>,
	namespaces: Set<string>,
): void {
	const namespaceImport = declaration.getNamespaceImport();
	const wanted = declaration
		.getNamedImports()
		.filter((named) => !named.isTypeOnly())
		.filter((named) => CANONICAL_EXPORTS.has(named.getName()));
	if (wanted.length === 0 && !namespaceImport) {
		return;
	}
	const barrel = resolveRelativeModule(
		ctx.project,
		sourceFile,
		declaration.getModuleSpecifierValue(),
	);
	if (!barrel) {
		return;
	}
	// `import * as po from "./pom"` binds every export at once, so there is no
	// imported name to test cheaply and no canonical name to map it to. The
	// question is only whether this barrel leads to the library at all; if it
	// does, `canonicalLocalName` resolves `po.Selector` from the suffix, and a
	// suffix outside `CANONICAL_EXPORTS` is rejected there as it always was.
	if (namespaceImport && barrelReachesLibrary(barrel, ctx, new Set())) {
		namespaces.add(namespaceImport.getText());
	}
	for (const named of wanted) {
		const canonical = canonicalThroughBarrel(
			barrel,
			named.getName(),
			ctx,
			new Set(),
		);
		if (canonical === undefined) {
			continue;
		}
		const alias = named.getAliasNode();
		aliases.set(alias ? alias.getText() : named.getName(), canonical);
	}
}

/**
 * Whether any export of this barrel comes from the library.
 *
 * One walk rather than one per canonical name: a namespace import binds the
 * whole module, so the question is about the barrel and not about a name.
 */
function barrelReachesLibrary(
	file: SourceFile,
	ctx: AnalysisContext,
	seen: Set<string>,
): boolean {
	if (seen.size >= MAX_BARREL_HOPS || seen.has(file.getFilePath())) {
		return false;
	}
	seen.add(file.getFilePath());
	for (const declaration of file.getExportDeclarations()) {
		if (declaration.isTypeOnly()) {
			continue;
		}
		const specifier = declaration.getModuleSpecifierValue();
		if (specifier === undefined) {
			continue;
		}
		if (isDirectLibrarySpecifier(specifier, ctx)) {
			return true;
		}
		const next = resolveRelativeModule(ctx.project, file, specifier);
		if (next && barrelReachesLibrary(next, ctx, seen)) {
			return true;
		}
	}
	return false;
}

/** The module `local` was imported from in `file`, for a bare `export { local }`. */
function importedFrom(file: SourceFile, local: string): string | undefined {
	for (const declaration of file.getImportDeclarations()) {
		if (declaration.isTypeOnly()) {
			continue;
		}
		for (const named of declaration.getNamedImports()) {
			if (named.isTypeOnly()) {
				continue;
			}
			const bound = (named.getAliasNode() ?? named.getNameNode()).getText();
			if (bound === local) {
				return declaration.getModuleSpecifierValue();
			}
		}
	}
	return undefined;
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
			// Not the package by name — but it may be a project barrel that
			// re-exports it. Only worth resolving when a name being imported could
			// be one of ours; every other relative import in the repository is
			// dismissed on a set lookup.
			if (isRelativeSpecifier(specifier) && !declaration.isTypeOnly()) {
				collectThroughBarrel(sourceFile, declaration, ctx, aliases, namespaces);
			}
			continue;
		}
		// `import type { Selector }` is erased before runtime: it can never be a
		// decorator or a base class, so treating it as one would report page
		// objects and selectors that do not exist.
		if (declaration.isTypeOnly()) {
			continue;
		}
		const namespaceImport = declaration.getNamespaceImport();
		if (namespaceImport) {
			namespaces.add(namespaceImport.getText());
		}
		for (const named of declaration.getNamedImports()) {
			if (named.isTypeOnly()) {
				continue;
			}
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
	return canonicalLocalName(decorator.getFullName(), imports);
}

/**
 * Canonical library name behind an identifier reference.
 *
 * Accepts the qualified `ns.PageObject` form as well as a bare local name, so
 * base classes and built-in controls reached through
 * `import * as po from "playwright-page-object"` are recognised exactly like
 * the decorators already were.
 */
export function canonicalLocalName(
	localName: string,
	imports: LibraryImports,
): string | undefined {
	const dot = localName.indexOf(".");
	if (dot > 0) {
		const namespace = localName.slice(0, dot);
		const member = localName.slice(dot + 1);
		if (imports.namespaces.has(namespace) && CANONICAL_EXPORTS.has(member)) {
			return member;
		}
		return undefined;
	}
	return imports.aliases.get(localName);
}
