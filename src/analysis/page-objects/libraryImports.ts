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
 * A cost bound, not the termination argument - the `visited` memo is that, and
 * it holds however deep the chain goes. It was 5, which cut a six-barrel chain off
 * before its exports were read; a monorepo that re-exports through a package
 * index, a testing index and a per-app shim reaches that without trying.
 */
const MAX_BARREL_FILES = 32;

/**
 * Every canonical library name a local barrel publishes, by the name it
 * publishes it under.
 *
 * Re-exporting the library through one project module - `export { Selector }
 * from "playwright-page-object"` in `src/testing/pom.ts`, imported everywhere
 * as `from "../testing/pom"` - is a normal convention, and it used to defeat
 * discovery completely: the specifier is relative, so no name was recognised,
 * the decorator map came back empty, and every class in the repository
 * disappeared from `list_page_objects`, the trees and coverage at once.
 *
 * A map rather than a per-name lookup or a "does this barrel reach the
 * library" boolean. The boolean was the bug behind namespace imports: a barrel
 * that re-exports `PageObject` from the package *and* defines its own
 * `Selector` made the whole namespace trusted, so `po.Selector` resolved to the
 * library's decorator and the project's own was never seen. Name by name is the
 * only honest answer, and one walk produces all of them.
 *
 * Only `export ... from` and `export *` are followed, plus the two-step
 * `import { X } from "the-library"; export { X };`. A local `export const
 * Selector = ...` is not in the map, which is exactly the point.
 */
function barrelExports(
	file: SourceFile,
	ctx: AnalysisContext,
	visited: Map<string, Map<string, string> | null>,
): Map<string, string> {
	const key = file.getFilePath();
	const cached = visited.get(key);
	if (cached !== undefined) {
		// `null` marks a file on the current path: a cycle. Contribute nothing
		// rather than recursing. Anything else is this module's finished answer,
		// which is the whole reason this is a cache and not a visited set — a
		// second lookup of the same module has to give the same answer as the
		// first, not an empty one.
		return cached ?? new Map();
	}
	if (visited.size >= MAX_BARREL_FILES) {
		return new Map();
	}
	visited.set(key, null);
	const out = new Map<string, string>();

	/** What `specifier` publishes, by outward name. */
	const through = (specifier: string): Map<string, string> => {
		if (isDirectLibrarySpecifier(specifier, ctx)) {
			return new Map([...CANONICAL_EXPORTS].map((name) => [name, name]));
		}
		const next = resolveRelativeModule(ctx.project, file, specifier);
		return next ? barrelExports(next, ctx, visited) : new Map();
	};

	for (const declaration of file.getExportDeclarations()) {
		if (declaration.isTypeOnly()) {
			continue;
		}
		const specifier = declaration.getModuleSpecifierValue();
		const named = declaration.getNamedExports();
		if (named.length === 0) {
			// `export * as controls from "the-library"` publishes exactly one name -
			// `controls` - and treating it as a star export claimed the barrel
			// re-exported every library name directly.
			if (declaration.getNamespaceExport() || specifier === undefined) {
				continue;
			}
			for (const [name, canonical] of through(specifier)) {
				out.set(name, canonical);
			}
			continue;
		}
		for (const one of named) {
			if (one.isTypeOnly()) {
				continue;
			}
			const inward = one.getName();
			const outward = (one.getAliasNode() ?? one.getNameNode()).getText();
			// `export { X } from "..."`, or a bare `export { X }` re-publishing
			// something this file imported.
			const hop = specifier ?? importedFrom(file, inward);
			const canonical = hop ? through(hop).get(inward) : undefined;
			if (canonical) {
				out.set(outward, canonical);
			}
		}
	}
	visited.set(key, out);
	return out;
}

/**
 * Adds whatever a relative import turns out to have taken from the library.
 *
 * Named imports are filtered on the imported name before anything is resolved,
 * so a repository's ordinary relative imports are dismissed on a set lookup and
 * never load a module. A namespace import has no such name and always resolves
 * its barrel - which is why {@link barrelExports} answers in one walk.
 */
function collectThroughBarrel(
	sourceFile: SourceFile,
	declaration: ImportDeclaration,
	ctx: AnalysisContext,
	aliases: Map<string, string>,
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
	const published = barrelExports(barrel, ctx, new Map());
	if (published.size === 0) {
		return;
	}

	if (namespaceImport) {
		// Recorded per member rather than by trusting the namespace wholesale:
		// `po.Selector` is the library's only if *this barrel* got `Selector` from
		// the library. `canonicalLocalName` reads these dotted keys.
		const prefix = namespaceImport.getText();
		for (const [name, canonical] of published) {
			aliases.set(`${prefix}.${name}`, canonical);
		}
	}
	for (const named of wanted) {
		const canonical = published.get(named.getName());
		if (canonical === undefined) {
			continue;
		}
		const alias = named.getAliasNode();
		aliases.set(alias ? alias.getText() : named.getName(), canonical);
	}
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
				collectThroughBarrel(sourceFile, declaration, ctx, aliases);
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
		// A namespace import of a project *barrel* is recorded member by member,
		// because only some of what it publishes may be ours. See
		// `collectThroughBarrel`.
		return imports.aliases.get(localName);
	}
	return imports.aliases.get(localName);
}
