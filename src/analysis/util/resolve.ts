import * as path from "node:path";
import {
	type CompilerOptions,
	type ModuleDeclaration,
	Node,
	type Project,
	type SourceFile,
	SyntaxKind,
} from "ts-morph";
import type { DynamicReason } from "../types";
import { toPosix } from "./paths";

export type RefKind = "class" | "function" | "variable" | "other";

export interface ResolvedRef {
	resolved: true;
	kind: RefKind;
	/** Declared name, which may differ from the local alias used at the call site. */
	name: string;
	declaration: Node;
	sourceFile: SourceFile;
}

export interface ExternalRef {
	resolved: false;
	external: true;
	module: string;
	/** Exported name in the external module (`"default"` for a default import). */
	name: string;
}

export interface UnresolvedRef {
	resolved: false;
	external: false;
	name: string;
	reason: DynamicReason;
}

export type RefResolution = ResolvedRef | ExternalRef | UnresolvedRef;

/**
 * A name as written (`pages.HomePage`) next to the bare identifier it ends in
 * (`HomePage`).
 *
 * Resolution and library-alias lookup need the qualified form so a namespace
 * import stays analysable; everything user-facing reports the simple name.
 */
export interface NameRef {
	qualified: string;
	simple: string;
}

/** Reads `X` or `ns.X` from an expression position. */
export function readNameRef(node: Node): NameRef | null {
	if (Node.isIdentifier(node)) {
		const text = node.getText();
		return { qualified: text, simple: text };
	}
	if (Node.isPropertyAccessExpression(node)) {
		return {
			qualified: `${node.getExpression().getText()}.${node.getName()}`,
			simple: node.getName(),
		};
	}
	return null;
}

export interface ResolveOptions {
	/** Set to `false` to keep the type checker out of the hot path entirely. */
	preferSyntacticResolution?: boolean;
	/** Re-export hops (`export { X } from`, `export *`) to follow. */
	maxHops?: number;
}

const DEFAULT_HOPS = 4;

const EXTENSION_CANDIDATES = [
	".ts",
	".tsx",
	".mts",
	".cts",
	".d.ts",
	".js",
	".jsx",
];

export function isInNodeModules(filePath: string): boolean {
	return toPosix(filePath).includes("/node_modules/");
}

export function isRelativeSpecifier(specifier: string): boolean {
	return specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * Resolves a module path prefix (no extension) to a file already in — or
 * addable to — the project, trying every extension and the `index.*` form.
 */
function loadFromBase(project: Project, base: string): SourceFile | undefined {
	const bases = [base];
	// NodeNext ESM style: `./x.js` on disk is `./x.ts`.
	const jsExt = /\.([cm]?)js$/.exec(base);
	if (jsExt) {
		bases.push(base.replace(/\.([cm]?)js$/, `.${jsExt[1]}ts`));
		bases.push(base.replace(/\.[cm]?js$/, ".ts"));
		bases.push(base.replace(/\.[cm]?js$/, ".tsx"));
	}

	const candidates: string[] = [];
	for (const candidateBase of bases) {
		candidates.push(candidateBase);
		for (const ext of EXTENSION_CANDIDATES) {
			candidates.push(candidateBase + ext);
		}
		for (const ext of EXTENSION_CANDIDATES) {
			candidates.push(path.posix.join(candidateBase, `index${ext}`));
		}
	}

	for (const candidate of candidates) {
		const existing = project.getSourceFile(candidate);
		if (existing) {
			return existing;
		}
	}
	for (const candidate of candidates) {
		if (!/\.[cm]?[jt]sx?$/.test(candidate)) {
			continue;
		}
		try {
			const added = project.addSourceFileAtPathIfExists(candidate);
			if (added) {
				return added;
			}
		} catch {
			// A path that cannot be stat'ed is simply not a candidate.
		}
	}
	return undefined;
}

/**
 * Resolves a relative module specifier to a file already in — or addable to —
 * the project. Bare specifiers deliberately return `undefined`: use
 * {@link resolveModuleSpecifier}, which also consults the tsconfig `paths`
 * table. Neither ever walks into `node_modules`: library base classes are
 * identified by *name plus import source*, which is what lets the engine work
 * on a freshly cloned repo with no install.
 */
export function resolveRelativeModule(
	project: Project,
	fromFile: SourceFile,
	specifier: string,
): SourceFile | undefined {
	if (!isRelativeSpecifier(specifier)) {
		return undefined;
	}
	return loadFromBase(
		project,
		path.posix.join(toPosix(fromFile.getDirectoryPath()), toPosix(specifier)),
	);
}

/**
 * Directory the tsconfig `paths` entries are written relative to.
 *
 * `baseUrl` when there is one; otherwise TypeScript records the config's own
 * directory as `pathsBasePath` (paths without baseUrl, allowed since TS 4.1).
 */
function pathsBaseDir(options: CompilerOptions): string | undefined {
	const baseUrl = options.baseUrl;
	if (typeof baseUrl === "string" && baseUrl !== "") {
		return toPosix(baseUrl);
	}
	const pathsBasePath = (options as { pathsBasePath?: unknown }).pathsBasePath;
	if (typeof pathsBasePath === "string" && pathsBasePath !== "") {
		return toPosix(pathsBasePath);
	}
	return undefined;
}

/**
 * Splits a `paths` key into its prefix and suffix around the single `*`.
 *
 * TypeScript allows **at most one** `*` per pattern and ignores any key that
 * breaks that rule (`tryParsePattern`), so a two-star key matches nothing here
 * either — rather than silently substituting into the first star only.
 */
function parsePathsPattern(
	pattern: string,
): { exact: true } | { exact: false; prefix: string; suffix: string } | null {
	const star = pattern.indexOf("*");
	if (star < 0) {
		return { exact: true };
	}
	if (pattern.indexOf("*", star + 1) >= 0) {
		return null;
	}
	return {
		exact: false,
		prefix: pattern.slice(0, star),
		suffix: pattern.slice(star + 1),
	};
}

/**
 * Puts the matched wildcard text into a `paths` substitution.
 *
 * Same one-star rule as the pattern side: a substitution with a second `*` is
 * rejected by `tsc` (TS5062) and is dropped here instead of being half-filled.
 */
function applySubstitution(
	target: string,
	matchedStar: string | null,
): string | null {
	const star = target.indexOf("*");
	if (star < 0 || matchedStar === null) {
		return target;
	}
	if (target.indexOf("*", star + 1) >= 0) {
		return null;
	}
	return target.slice(0, star) + matchedStar + target.slice(star + 1);
}

/**
 * Absolute path prefixes the tsconfig `paths` table maps a specifier to.
 *
 * Only the *best* pattern contributes, as in TypeScript: an exact key wins
 * outright, otherwise the longest matching prefix does, and the first key of
 * that length wins a tie. Falling through to a shorter pattern when the best
 * one's targets do not exist would resolve `@/components/Cart` against a
 * catch-all `@/*` that TypeScript never consults.
 *
 * Returns `null` when no pattern matched at all — which is what lets the caller
 * fall back to `baseUrl`, exactly as `tryLoadModuleUsingPathsIfEligible` does.
 */
function pathsTargets(
	paths: Record<string, string[] | undefined>,
	base: string,
	specifier: string,
): string[] | null {
	let bestTargets: string[] | undefined;
	let bestStar: string | null = null;
	let bestPrefixLength = -1;

	for (const [pattern, targets] of Object.entries(paths)) {
		const parsed = parsePathsPattern(pattern);
		if (!parsed) {
			continue;
		}
		if (parsed.exact) {
			if (pattern === specifier) {
				// An exact key is unique and beats every wildcard.
				return substitutedBases(targets ?? [], null, base);
			}
			continue;
		}
		const { prefix, suffix } = parsed;
		if (
			!specifier.startsWith(prefix) ||
			!specifier.endsWith(suffix) ||
			specifier.length < prefix.length + suffix.length
		) {
			continue;
		}
		if (prefix.length <= bestPrefixLength) {
			continue;
		}
		bestPrefixLength = prefix.length;
		bestStar = specifier.slice(prefix.length, specifier.length - suffix.length);
		bestTargets = targets ?? [];
	}

	return bestTargets ? substitutedBases(bestTargets, bestStar, base) : null;
}

function substitutedBases(
	targets: string[],
	matchedStar: string | null,
	base: string,
): string[] {
	const out: string[] = [];
	for (const target of targets) {
		const substituted = applySubstitution(toPosix(target), matchedStar);
		if (substituted !== null) {
			out.push(path.posix.join(base, substituted));
		}
	}
	return out;
}

/**
 * Absolute path prefixes a non-relative specifier maps to.
 *
 * Two mechanisms, in TypeScript's own order: the tsconfig `paths` table, and —
 * when no pattern matched — plain `baseUrl` resolution, under which
 * `components/Cart` is a perfectly ordinary local import that needs no `paths`
 * entry at all.
 */
function mappedModuleBases(project: Project, specifier: string): string[] {
	const options = project.getCompilerOptions();
	const pathsBase = pathsBaseDir(options);
	if (options.paths && pathsBase) {
		const matched = pathsTargets(options.paths, pathsBase, specifier);
		// A matched pattern commits: TypeScript does not retry under `baseUrl`.
		if (matched) {
			return matched;
		}
	}
	const baseUrl = options.baseUrl;
	if (typeof baseUrl === "string" && baseUrl !== "") {
		return [path.posix.join(toPosix(baseUrl), specifier)];
	}
	return [];
}

/**
 * Resolves any module specifier the analysed project can own: relative, or
 * non-relative through the tsconfig `paths` table or `baseUrl`.
 *
 * Without the alias half, a repo that writes `@/components/Cart` has every
 * import classified as external, so nested controls and component trees stop
 * dead at the first aliased hop even though the file is right there in the
 * project. Anything landing in `node_modules` is still rejected — an alias into
 * a dependency is an external module however it is spelled.
 */
export function resolveModuleSpecifier(
	project: Project,
	fromFile: SourceFile,
	specifier: string,
): SourceFile | undefined {
	if (isRelativeSpecifier(specifier)) {
		return resolveRelativeModule(project, fromFile, specifier);
	}
	for (const base of mappedModuleBases(project, specifier)) {
		// Rejected *before* `loadFromBase`, not after: adding the file to the
		// project first would parse a dependency into the AST only to throw the
		// result away, which is exactly the boundary the engine promises to hold.
		if (isInNodeModules(base)) {
			continue;
		}
		const found = loadFromBase(project, base);
		if (found && !isInNodeModules(found.getFilePath())) {
			return found;
		}
	}
	return undefined;
}

interface ImportBinding {
	specifier: string;
	/** Name as exported by the target module; `"default"` / `"*"` are special. */
	exportedName: string;
}

/** Finds the import that introduces `localName` into `sourceFile`. */
export function findImportBinding(
	sourceFile: SourceFile,
	localName: string,
): ImportBinding | undefined {
	for (const declaration of sourceFile.getImportDeclarations()) {
		const specifier = declaration.getModuleSpecifierValue();
		const defaultImport = declaration.getDefaultImport();
		if (defaultImport && defaultImport.getText() === localName) {
			return { specifier, exportedName: "default" };
		}
		const namespaceImport = declaration.getNamespaceImport();
		if (namespaceImport && namespaceImport.getText() === localName) {
			return { specifier, exportedName: "*" };
		}
		for (const named of declaration.getNamedImports()) {
			const alias = named.getAliasNode();
			const local = alias ? alias.getText() : named.getName();
			if (local === localName) {
				return { specifier, exportedName: named.getName() };
			}
		}
	}
	return undefined;
}

function classifyDeclaration(node: Node): RefKind {
	if (Node.isClassDeclaration(node) || Node.isClassExpression(node)) {
		return "class";
	}
	if (
		Node.isFunctionDeclaration(node) ||
		Node.isArrowFunction(node) ||
		Node.isFunctionExpression(node)
	) {
		return "function";
	}
	if (Node.isVariableDeclaration(node)) {
		return "variable";
	}
	return "other";
}

function localDeclaration(
	sourceFile: SourceFile,
	name: string,
): Node | undefined {
	return (
		sourceFile.getClass(name) ??
		sourceFile.getFunction(name) ??
		sourceFile.getVariableDeclaration(name) ??
		sourceFile.getEnum(name)
	);
}

function resolveDefaultExport(
	project: Project,
	sourceFile: SourceFile,
	hops: number,
): ResolvedRef | undefined {
	for (const declaration of sourceFile.getClasses()) {
		if (declaration.isDefaultExport()) {
			return asResolved(declaration, sourceFile, declaration.getName());
		}
	}
	for (const declaration of sourceFile.getFunctions()) {
		if (declaration.isDefaultExport()) {
			return asResolved(declaration, sourceFile, declaration.getName());
		}
	}
	for (const assignment of sourceFile.getExportAssignments()) {
		if (assignment.isExportEquals()) {
			continue;
		}
		const expression = assignment.getExpression();
		if (Node.isIdentifier(expression)) {
			const local = localDeclaration(sourceFile, expression.getText());
			if (local) {
				return asResolved(local, sourceFile, expression.getText());
			}
			const viaImport = resolveThroughImport(
				project,
				sourceFile,
				expression.getText(),
				hops,
			);
			if (viaImport?.resolved) {
				return viaImport;
			}
		}
		if (Node.isClassExpression(expression)) {
			return asResolved(expression, sourceFile, expression.getName());
		}
		// `export default () => <div/>` / `export default function () {}`.
		if (Node.isArrowFunction(expression)) {
			return asResolved(expression, sourceFile, undefined);
		}
		if (Node.isFunctionExpression(expression)) {
			return asResolved(expression, sourceFile, expression.getName());
		}
	}
	// `export { X as default }` and `export { default } from "./X"`.
	for (const declaration of sourceFile.getExportDeclarations()) {
		const moduleSpecifier = declaration.getModuleSpecifierValue();
		for (const specifier of declaration.getNamedExports()) {
			const alias = specifier.getAliasNode();
			const exposed = alias ? alias.getText() : specifier.getName();
			if (exposed !== "default") {
				continue;
			}
			const target = moduleSpecifier
				? (resolveModuleSpecifier(project, sourceFile, moduleSpecifier) ??
					sourceFile)
				: sourceFile;
			// `export { default }` with no module specifier would recurse forever.
			if (target === sourceFile && specifier.getName() === "default") {
				continue;
			}
			const resolved = resolveExportedName(
				project,
				target,
				specifier.getName(),
				hops - 1,
			);
			if (resolved?.resolved) {
				return resolved;
			}
		}
	}
	return undefined;
}

function asResolved(
	declaration: Node,
	sourceFile: SourceFile,
	name: string | undefined,
): ResolvedRef {
	return {
		resolved: true,
		kind: classifyDeclaration(declaration),
		name: name ?? "default",
		declaration,
		sourceFile,
	};
}

/** Looks up `exportName` in `sourceFile`, following re-export hops. */
export function resolveExportedName(
	project: Project,
	sourceFile: SourceFile,
	exportName: string,
	hops = DEFAULT_HOPS,
): ResolvedRef | undefined {
	if (hops < 0) {
		return undefined;
	}
	if (exportName === "default") {
		return resolveDefaultExport(project, sourceFile, hops);
	}

	const local = localDeclaration(sourceFile, exportName);
	if (local) {
		return asResolved(local, sourceFile, exportName);
	}

	for (const declaration of sourceFile.getExportDeclarations()) {
		const specifier = declaration.getModuleSpecifierValue();
		const namedExports = declaration.getNamedExports();

		if (namedExports.length > 0) {
			for (const named of namedExports) {
				const alias = named.getAliasNode();
				const exposed = alias ? alias.getText() : named.getName();
				if (exposed !== exportName) {
					continue;
				}
				if (!specifier) {
					// `import { Card } from "./Card"; export { Card };` — a local
					// re-export of an imported binding. Recursing into this same file
					// would just re-run the failed local lookup.
					const viaImport = resolveThroughImport(
						project,
						sourceFile,
						named.getName(),
						hops - 1,
					);
					if (viaImport?.resolved) {
						return viaImport;
					}
					continue;
				}
				const target = resolveModuleSpecifier(project, sourceFile, specifier);
				if (!target) {
					return undefined;
				}
				const resolved = resolveExportedName(
					project,
					target,
					named.getName(),
					hops - 1,
				);
				if (resolved) {
					return resolved;
				}
			}
			continue;
		}

		// `export * from "./x"`
		if (specifier) {
			const target = resolveModuleSpecifier(project, sourceFile, specifier);
			if (target && target !== sourceFile) {
				const resolved = resolveExportedName(
					project,
					target,
					exportName,
					hops - 1,
				);
				if (resolved) {
					return resolved;
				}
			}
		}
	}

	// Fall back to a non-exported local declaration: an intermediate base class
	// does not have to be exported to be part of the inheritance chain.
	const anyLocal = sourceFile
		.getClasses()
		.find((declaration) => declaration.getName() === exportName);
	return anyLocal ? asResolved(anyLocal, sourceFile, exportName) : undefined;
}

function resolveThroughImport(
	project: Project,
	sourceFile: SourceFile,
	localName: string,
	hops: number,
): RefResolution | undefined {
	const binding = findImportBinding(sourceFile, localName);
	if (!binding) {
		return undefined;
	}
	const target = resolveModuleSpecifier(project, sourceFile, binding.specifier);
	if (!target) {
		// A bare specifier the tsconfig does not map is a real dependency.
		if (!isRelativeSpecifier(binding.specifier)) {
			return {
				resolved: false,
				external: true,
				module: binding.specifier,
				name: binding.exportedName === "*" ? localName : binding.exportedName,
			};
		}
		return {
			resolved: false,
			external: false,
			name: localName,
			reason: "identifier-unresolved",
		};
	}
	if (binding.exportedName === "*") {
		return {
			resolved: false,
			external: false,
			name: localName,
			reason: "unsupported-syntax",
		};
	}
	const resolved = resolveExportedName(
		project,
		target,
		binding.exportedName,
		hops,
	);
	return (
		resolved ?? {
			resolved: false,
			external: false,
			name: localName,
			reason: "identifier-unresolved",
		}
	);
}

/** A scope that can hold exported declarations: a module file or a `namespace`. */
type ExportScope = SourceFile | ModuleDeclaration;

/**
 * Follows one namespace segment: `export * as seg from "./x"` in a module, or a
 * `namespace seg {}` declaration in either kind of scope.
 */
function namespaceHop(
	project: Project,
	scope: ExportScope,
	segment: string,
): ExportScope | undefined {
	if (Node.isSourceFile(scope)) {
		for (const declaration of scope.getExportDeclarations()) {
			if (declaration.getNamespaceExport()?.getName() !== segment) {
				continue;
			}
			const specifier = declaration.getModuleSpecifierValue();
			const target = specifier
				? resolveModuleSpecifier(project, scope, specifier)
				: undefined;
			if (target) {
				return target;
			}
		}
	}
	return scope.getModule(segment);
}

/** Looks a name up inside a `namespace` body, mirroring {@link localDeclaration}. */
function moduleMember(
	scope: ModuleDeclaration,
	name: string,
): Node | undefined {
	return (
		scope.getClass(name) ??
		scope.getFunction(name) ??
		scope.getVariableDeclaration(name) ??
		scope.getEnum(name)
	);
}

/**
 * `ns.Member`, including nested chains such as `pages.controls.Button`.
 *
 * Without this, `new pages.HomePage(page)` and `class X extends po.PageObject`
 * lose the qualifier before resolution and are reported as unresolvable, even
 * though the namespace form is fully static. Each leading segment is one
 * namespace hop — a `export * as x from` re-export or a `namespace x {}` — and
 * a chain that cannot be walked is reported as unsupported rather than quietly
 * dropping the reference.
 */
function resolveNamespaceMember(
	project: Project,
	sourceFile: SourceFile,
	namespaceName: string,
	memberPath: string[],
	hops: number,
): RefResolution {
	const memberName = memberPath[memberPath.length - 1];
	const unresolved: UnresolvedRef = {
		resolved: false,
		external: false,
		name: memberName,
		reason: "identifier-unresolved",
	};
	const binding = findImportBinding(sourceFile, namespaceName);
	let scope: ExportScope | undefined;
	if (binding?.exportedName === "*") {
		const target = resolveModuleSpecifier(
			project,
			sourceFile,
			binding.specifier,
		);
		if (!target) {
			if (!isRelativeSpecifier(binding.specifier)) {
				return {
					resolved: false,
					external: true,
					module: binding.specifier,
					name: memberName,
				};
			}
			return unresolved;
		}
		scope = target;
	} else if (!binding) {
		// `namespace pages { … }` declared right here in the file.
		scope = sourceFile.getModule(namespaceName);
	}
	if (!scope) {
		return unresolved;
	}

	for (const segment of memberPath.slice(0, -1)) {
		const next = namespaceHop(project, scope, segment);
		if (!next) {
			return {
				resolved: false,
				external: false,
				name: memberName,
				reason: "unsupported-syntax",
			};
		}
		scope = next;
	}

	if (Node.isSourceFile(scope)) {
		return resolveExportedName(project, scope, memberName, hops) ?? unresolved;
	}
	const declaration = moduleMember(scope, memberName);
	return declaration
		? asResolved(declaration, scope.getSourceFile(), memberName)
		: unresolved;
}

/**
 * Syntax-first identifier resolution.
 *
 * 1. Local declaration in the same file.
 * 2. Import declaration in the same file, resolved by hand against the
 *    filesystem (relative specifiers only).
 * 3. Type-checker fallback, and only then — instantiating the checker is the
 *    single most expensive thing this engine can do.
 */
export function resolveIdentifier(
	project: Project,
	sourceFile: SourceFile,
	localName: string,
	options: ResolveOptions = {},
): RefResolution {
	const hops = options.maxHops ?? DEFAULT_HOPS;

	const dot = localName.indexOf(".");
	if (dot > 0) {
		const segments = localName.split(".");
		return resolveNamespaceMember(
			project,
			sourceFile,
			segments[0],
			segments.slice(1),
			hops,
		);
	}

	const local = localDeclaration(sourceFile, localName);
	if (local) {
		return asResolved(local, sourceFile, localName);
	}

	const viaImport = resolveThroughImport(project, sourceFile, localName, hops);
	if (viaImport) {
		return viaImport;
	}

	if (options.preferSyntacticResolution === false) {
		return checkerFallback(sourceFile, localName);
	}

	return {
		resolved: false,
		external: false,
		name: localName,
		reason: "identifier-unresolved",
	};
}

function checkerFallback(
	sourceFile: SourceFile,
	localName: string,
): RefResolution {
	const identifier = sourceFile
		.getDescendantsOfKind(SyntaxKind.Identifier)
		.find((node) => node.getText() === localName);
	if (identifier) {
		for (const definition of identifier.getDefinitionNodes()) {
			const definitionFile = definition.getSourceFile();
			if (isInNodeModules(definitionFile.getFilePath())) {
				continue;
			}
			return asResolved(definition, definitionFile, localName);
		}
	}
	return {
		resolved: false,
		external: false,
		name: localName,
		reason: "identifier-unresolved",
	};
}

/**
 * Resolves the class an identifier refers to, rejecting anything that is not a
 * class declaration (a function of the same name is not a page object).
 */
export function resolveClassRef(
	project: Project,
	sourceFile: SourceFile,
	localName: string,
	options?: ResolveOptions,
): RefResolution {
	const resolution = resolveIdentifier(project, sourceFile, localName, options);
	if (resolution.resolved && resolution.kind !== "class") {
		// A variable holding a class expression still counts.
		if (Node.isVariableDeclaration(resolution.declaration)) {
			const initializer = resolution.declaration.getInitializer();
			if (initializer && Node.isClassExpression(initializer)) {
				return asResolved(initializer, resolution.sourceFile, resolution.name);
			}
		}
	}
	return resolution;
}

/** True when the identifier resolves to something callable as a factory. */
export function resolvesToCallable(resolution: RefResolution): boolean {
	if (!resolution.resolved) {
		return false;
	}
	if (resolution.kind === "class" || resolution.kind === "function") {
		return true;
	}
	if (Node.isVariableDeclaration(resolution.declaration)) {
		const initializer = resolution.declaration.getInitializer();
		return (
			!!initializer &&
			(Node.isArrowFunction(initializer) ||
				Node.isFunctionExpression(initializer) ||
				Node.isClassExpression(initializer))
		);
	}
	return false;
}
