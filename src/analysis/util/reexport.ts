import {
	type ModuleDeclaration,
	Node,
	type Project,
	type SourceFile,
} from "ts-morph";
import { unwrapTransparent } from "./ast";
import { hasDefaultKeyword } from "./exports";
import { isRelativeSpecifier } from "./moduleFile";
import { probeWorkspacePackage, resolveModuleSpecifier } from "./packageFile";
import type {
	RefKind,
	RefResolution,
	ResolvedRef,
	UnresolvedRef,
} from "./resolve";

/**
 * How far a name may be followed across import, re-export and namespace
 * hops before the answer stops being provable.
 *
 * Split out of `resolve.ts`, which keeps the vocabulary a resolution is
 * reported in and the entry points that produce one.
 */

/**
 * Re-export hops one lookup may follow.
 *
 * Was 4, and it was doing two jobs: bounding cost *and* stopping a cyclic
 * re-export (`index.ts` and `a.ts` re-exporting each other) from recursing
 * forever. The second job is why it could not simply be raised - and why it
 * was too low for a design system whose public name reaches its declaration
 * through five nested index files.
 *
 * `visitedExports` now decides termination, so this is a budget again. What
 * made the old value expensive to be wrong about: exhaustion does not produce
 * a "too deep" answer, it produces `identifier-unresolved`, and the hint for
 * that code tells the caller to root a tree at the component - which runs the
 * same lookup with the same budget and fails the same way.
 */
export const DEFAULT_HOPS = 64;

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

export function localDeclaration(
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
	visited: Set<string>,
): ResolvedRef | undefined {
	for (const declaration of sourceFile.getClasses()) {
		if (hasDefaultKeyword(declaration)) {
			return asResolved(declaration, sourceFile, declaration.getName());
		}
	}
	for (const declaration of sourceFile.getFunctions()) {
		if (hasDefaultKeyword(declaration)) {
			return asResolved(declaration, sourceFile, declaration.getName());
		}
	}
	for (const assignment of sourceFile.getExportAssignments()) {
		if (assignment.isExportEquals()) {
			continue;
		}
		// Unwrapped before it is classified. `export default (Card)` and
		// `export default Card satisfies FC` name a component every bit as much
		// as the bare form, but each classification below is a syntax test, so a
		// wrapper made all of them miss: a default import of the module came back
		// unresolved and the walk stopped at a boundary that is not one.
		// `exportKindOf` already asks the upward half of this question through
		// `unwrapTransparentParent`.
		const expression = unwrapTransparent(assignment.getExpression());
		if (Node.isIdentifier(expression)) {
			const local = localDeclaration(sourceFile, expression.getText());
			if (local) {
				return asResolved(local, sourceFile, expression.getText());
			}
			const viaImport = resolveThroughImport(
				project,
				sourceFile,
				expression.getText(),
				hops - 1,
				visited,
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
				visited,
			);
			if (resolved?.resolved) {
				return resolved;
			}
			if (!moduleSpecifier) {
				// `import { Card } from "./Card"; export { Card as default };` — the
				// barrel's default export is an *imported* binding, so the lookup
				// above searched this file for a declaration that was never here.
				// Left unresolved, every default import of the barrel stops the
				// component walk at a boundary and turns a control reference dynamic.
				const viaImport = resolveThroughImport(
					project,
					sourceFile,
					specifier.getName(),
					hops - 1,
					visited,
				);
				if (viaImport?.resolved) {
					return viaImport;
				}
			}
		}
	}
	return undefined;
}

export function asResolved(
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

/**
 * Looks up `exportName` in `sourceFile`, following re-export hops.
 *
 * `visited` carries the `(file, name)` pairs already on the current lookup, so
 * a cyclic re-export terminates on the cycle rather than on the hop budget.
 * Callers never pass it; it exists so the budget can be a budget.
 */
export function resolveExportedName(
	project: Project,
	sourceFile: SourceFile,
	exportName: string,
	hops = DEFAULT_HOPS,
	visited: Set<string> = new Set(),
): ResolvedRef | undefined {
	if (hops < 0) {
		return undefined;
	}
	const visitKey = `${sourceFile.getFilePath()}\u0000${exportName}`;
	if (visited.has(visitKey)) {
		return undefined;
	}
	visited.add(visitKey);
	if (exportName === "default") {
		return resolveDefaultExport(project, sourceFile, hops, visited);
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
					// `class Card {}; export { Card as CheckoutCard };` — the alias is
					// what the importer asks for, but the declaration carries the
					// pre-alias name, so the local lookup at the top of this function
					// (which used the alias) found nothing. Try the declared name before
					// assuming the binding must have come from an import: treating a
					// locally declared class as unresolved turns imported components
					// into tree boundaries and page-object references into dynamic ones.
					const localAlias = localDeclaration(sourceFile, named.getName());
					if (localAlias) {
						return asResolved(localAlias, sourceFile, named.getName());
					}
					// `import { Card } from "./Card"; export { Card };` — a local
					// re-export of an imported binding. Recursing into this same file
					// would just re-run the failed local lookup.
					const viaImport = resolveThroughImport(
						project,
						sourceFile,
						named.getName(),
						hops - 1,
						visited,
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
					visited,
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
					visited,
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

/**
 * Follows a local name to the module it was imported from.
 *
 * `visited` is the same set {@link resolveExportedName} carries, and it has to
 * come through here too. Two modules can forward their defaults to each other -
 * `a.ts` doing `import B from "./b"; export default B` against a `b.ts` that
 * mirrors it - and that path leaves this function and re-enters
 * `resolveExportedName` on the other file. Starting a fresh set there meant
 * neither `(file, name)` pair was ever seen twice, so the cycle guard never
 * fired and the lookup recursed until the stack ran out.
 */
export function resolveThroughImport(
	project: Project,
	sourceFile: SourceFile,
	localName: string,
	hops: number,
	visited: Set<string> = new Set(),
): RefResolution | undefined {
	const binding = findImportBinding(sourceFile, localName);
	if (!binding) {
		return undefined;
	}
	const target = resolveModuleSpecifier(project, sourceFile, binding.specifier);
	if (!target) {
		// A bare specifier that maps nowhere and links to no workspace package is
		// a real dependency.
		if (!isRelativeSpecifier(binding.specifier)) {
			// One exception worth naming: a first-party package whose only
			// resolvable entry is compiled output. "External dependency" is the
			// wrong thing to tell an agent about code in its own repository.
			const probed = probeWorkspacePackage(
				project,
				sourceFile,
				binding.specifier,
			);
			return {
				resolved: false,
				external: true,
				module:
					probed.kind === "built-output"
						? `${binding.specifier} (built output)`
						: binding.specifier,
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
		visited,
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
export function resolveNamespaceMember(
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
