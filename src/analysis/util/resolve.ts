import { Node, type Project, type SourceFile, SyntaxKind } from "ts-morph";
import type { DynamicReason } from "../types";
import { unwrapTransparent } from "./ast";
import { isWorkspaceLocal } from "./workspaceRoot";

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
export function readNameRef(raw: Node): NameRef | null {
	// `(Control)`, `Control as any` and `Control!` all name `Control`. Testing
	// the raw node returned null for every one of them, which read downstream as
	// "no name here" — a decorator's factory argument reported unresolved, a
	// list's item reference lost, a fixture entry called dynamic. Unwrapping is
	// this reader's job, not each caller's; several of them did not know to.
	const node = unwrapTransparent(raw);
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

// The three layers below this one. Re-exported so the nine engine modules
// and four specs that deep-import `util/resolve` keep one path.
export {
	isInNodeModules,
	isRelativeSpecifier,
	resolveRelativeModule,
} from "./moduleFile";
export { clearResolutionCaches, resolveModuleSpecifier } from "./packageFile";
export { findImportBinding, resolveExportedName } from "./reexport";

import {
	asResolved,
	DEFAULT_HOPS,
	localDeclaration,
	resolveNamespaceMember,
	resolveThroughImport,
} from "./reexport";

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
		return checkerFallback(project, sourceFile, localName);
	}

	return {
		resolved: false,
		external: false,
		name: localName,
		reason: "identifier-unresolved",
	};
}

function checkerFallback(
	project: Project,
	sourceFile: SourceFile,
	localName: string,
): RefResolution {
	const identifier = sourceFile
		.getDescendantsOfKind(SyntaxKind.Identifier)
		.find((node) => node.getText() === localName);
	if (identifier) {
		for (const definition of identifier.getDefinitionNodes()) {
			const definitionFile = definition.getSourceFile();
			if (!isWorkspaceLocal(project, definitionFile.getFilePath())) {
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
