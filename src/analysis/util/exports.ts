import { Node, type SourceFile } from "ts-morph";
import { unwrapTransparent } from "./ast";

/**
 * Syntactic answers to "is this declaration exported / the default export".
 *
 * ts-morph's `isExported()` and `isDefaultExport()` look at the modifiers first
 * and then fall through to `getSymbol()`, which instantiates the TypeScript
 * program. That is the single most expensive thing this engine can do: building
 * the checker reads and parses every `.d.ts` the compiler options reach —
 * measured at 594 `node_modules` declaration files and hundreds of megabytes of
 * retained heap on one production monorepo — and it happened on a *syntax-only*
 * walk that never asks a type question.
 *
 * The fall-through is unavoidable through those APIs, because a keyword-less
 * declaration is exactly the case they exist to answer. A `VariableDeclaration`
 * can never carry a `default` keyword at all, so `variable.isDefaultExport()`
 * reached the checker on every single call.
 *
 * Everything the checker was being asked here is written in the source: an
 * `export`/`default` modifier, an `export default X` assignment, or an
 * `export { X }` / `export { X as default }` clause. These read those three
 * forms directly, which is both correct for the question and free.
 */

/** The node whose modifiers govern a declaration: the statement, for a `const`. */
function modifierHost(node: Node): Node {
	if (Node.isVariableDeclaration(node)) {
		return node.getVariableStatement() ?? node;
	}
	return node;
}

/** `export default class X {}` / `export default function X() {}`. */
export function hasDefaultKeyword(node: Node): boolean {
	const host = modifierHost(node);
	return Node.isExportGetable(host) ? host.hasDefaultKeyword() : false;
}

/** `export class X {}` / `export const x = …`. */
export function hasExportKeyword(node: Node): boolean {
	const host = modifierHost(node);
	return Node.isExportGetable(host) ? host.hasExportKeyword() : false;
}

/** The declared name, when the node has one that an export clause can name. */
function declaredName(node: Node): string | undefined {
	if (!Node.hasName(node)) {
		return undefined;
	}
	const name = String(node.getName());
	return name === "" ? undefined : name;
}

/**
 * `export default X` naming a local declaration.
 *
 * `export =` is CommonJS's whole-module export, not a default export, and
 * `getDefaultExportSymbol()` does not report it either.
 */
function isDefaultExportAssignment(
	sourceFile: SourceFile,
	name: string,
): boolean {
	for (const assignment of sourceFile.getExportAssignments()) {
		if (assignment.isExportEquals()) {
			continue;
		}
		const expression = unwrapTransparent(assignment.getExpression());
		if (Node.isIdentifier(expression) && expression.getText() === name) {
			return true;
		}
	}
	return false;
}

/**
 * Names a local declaration exposes through an `export { … }` clause.
 *
 * Clauses carrying a module specifier (`export { X } from "./other"`) are
 * skipped: they re-export somebody else's `X`, and say nothing about the local
 * declaration of that name.
 */
function exportClauseNames(
	sourceFile: SourceFile,
	name: string,
): { exported: boolean; asDefault: boolean } {
	let exported = false;
	for (const declaration of sourceFile.getExportDeclarations()) {
		if (declaration.getModuleSpecifierValue()) {
			continue;
		}
		for (const specifier of declaration.getNamedExports()) {
			if (specifier.getName() !== name) {
				continue;
			}
			exported = true;
			const alias = specifier.getAliasNode();
			if ((alias ? alias.getText() : specifier.getName()) === "default") {
				return { exported: true, asDefault: true };
			}
		}
	}
	return { exported, asDefault: false };
}

/**
 * Whether the declaration is this file's default export.
 *
 * Covers the three forms the checker-backed predicate covered: the `default`
 * modifier, `export default X`, and `export { X as default }`.
 */
export function isDefaultExported(node: Node): boolean {
	if (hasDefaultKeyword(node)) {
		return true;
	}
	const name = declaredName(node);
	if (name === undefined) {
		return false;
	}
	const sourceFile = node.getSourceFile();
	return (
		isDefaultExportAssignment(sourceFile, name) ||
		exportClauseNames(sourceFile, name).asDefault
	);
}

/** Whether the declaration leaves its module at all, under any name. */
export function isExported(node: Node): boolean {
	if (hasExportKeyword(node)) {
		return true;
	}
	const name = declaredName(node);
	if (name === undefined) {
		return false;
	}
	const sourceFile = node.getSourceFile();
	return (
		isDefaultExportAssignment(sourceFile, name) ||
		exportClauseNames(sourceFile, name).exported
	);
}
