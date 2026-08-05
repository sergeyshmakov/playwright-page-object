import {
	type ClassDeclaration,
	Node,
	type SourceFile,
	SyntaxKind,
} from "ts-morph";
import { info } from "../diagnostics";
import type { Diagnostic, FixtureBinding } from "../types";
import { rawText } from "../util/literal";
import { defKey, keyFold } from "../util/paths";
import { type NameRef, readNameRef, resolveClassRef } from "../util/resolve";
import {
	type AnalysisContext,
	canonicalLocalName,
	collectLibraryImports,
} from "./libraryImports";
import { refFromResolution } from "./members";

export interface FixtureMap {
	/** Case-folded def key to every fixture name bound to that class. */
	byClass: Map<string, FixtureBinding[]>;
	/** Fixture name to case-folded def key. */
	byName: Map<string, string>;
	/** Case-folded def key to the class declaration the binding resolved to. */
	declarations: Map<string, ClassDeclaration>;
	warnings: Diagnostic[];
}

/**
 * The class a `createFixtures` factory hands to the test.
 *
 * `createFixtures` calls the entry as `(page) => instance` and uses whatever it
 * *returns*, so the value is read off the return expression — never off the
 * first `new` anywhere in the body, which in
 * `(page) => { const helper = new Helper(); return new HomePage(page, helper); }`
 * is the wrong class entirely. A returned local is followed one hop to its
 * initializer; anything else is reported as dynamic.
 */
function factoryClass(fn: Node): NameRef | null {
	if (!Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn)) {
		return null;
	}
	let body: Node = fn.getBody();
	if (Node.isParenthesizedExpression(body)) {
		body = body.getExpression();
	}
	if (!Node.isBlock(body)) {
		return constructedClass(body, null);
	}
	const returns = body
		.getDescendantsOfKind(SyntaxKind.ReturnStatement)
		.filter((statement) => statement.getFirstAncestor(isFunctionLike) === fn);
	if (returns.length !== 1) {
		return null;
	}
	const returned = returns[0].getExpression();
	return returned ? constructedClass(returned, body) : null;
}

function isFunctionLike(node: Node): boolean {
	return (
		Node.isArrowFunction(node) ||
		Node.isFunctionExpression(node) ||
		Node.isFunctionDeclaration(node) ||
		Node.isMethodDeclaration(node)
	);
}

/** `new X(…)`, or an identifier initialised from one in the same block. */
function constructedClass(
	expression: Node,
	scope: Node | null,
): NameRef | null {
	if (Node.isParenthesizedExpression(expression)) {
		return constructedClass(expression.getExpression(), scope);
	}
	if (Node.isAwaitExpression(expression)) {
		return constructedClass(expression.getExpression(), scope);
	}
	if (Node.isNewExpression(expression)) {
		return readNameRef(expression.getExpression());
	}
	if (scope && Node.isIdentifier(expression)) {
		const name = expression.getText();
		for (const declaration of scope.getDescendantsOfKind(
			SyntaxKind.VariableDeclaration,
		)) {
			if (declaration.getName() !== name) {
				continue;
			}
			const initializer = declaration.getInitializer();
			return initializer ? constructedClass(initializer, null) : null;
		}
	}
	return null;
}

/**
 * Collects every `createFixtures({ … })` binding in the workspace.
 *
 * One class can be bound under several names and in several calls, which is why
 * the result is a list per class rather than a single binding.
 */
export function readFixtureMaps(
	files: SourceFile[],
	ctx: AnalysisContext,
): FixtureMap {
	const byClass = new Map<string, FixtureBinding[]>();
	const byName = new Map<string, string>();
	const declarations = new Map<string, ClassDeclaration>();
	const warnings: Diagnostic[] = [];

	for (const sourceFile of files) {
		const imports = collectLibraryImports(sourceFile, ctx);
		if (imports.aliases.size === 0 && imports.namespaces.size === 0) {
			continue;
		}

		for (const call of sourceFile.getDescendantsOfKind(
			SyntaxKind.CallExpression,
		)) {
			const callee = call.getExpression();
			let isCreateFixtures = false;
			if (Node.isIdentifier(callee)) {
				isCreateFixtures =
					canonicalLocalName(callee.getText(), imports) === "createFixtures";
			} else if (Node.isPropertyAccessExpression(callee)) {
				const namespace = callee.getExpression();
				isCreateFixtures =
					callee.getName() === "createFixtures" &&
					Node.isIdentifier(namespace) &&
					imports.namespaces.has(namespace.getText());
			}
			if (!isCreateFixtures) {
				continue;
			}

			const argument = call.getArguments()[0];
			if (!argument || !Node.isObjectLiteralExpression(argument)) {
				warnings.push(
					info(
						"fixtures-argument-dynamic",
						`createFixtures(${rawText(argument, 60) || ""}) is not called with an object literal, so its bindings cannot be read statically.`,
						ctx.ws.loc(argument ?? call),
					),
				);
				continue;
			}

			for (const property of argument.getProperties()) {
				let fixtureName: string | null = null;
				let value: Node | null = null;

				if (Node.isPropertyAssignment(property)) {
					const nameNode = property.getNameNode();
					if (Node.isComputedPropertyName(nameNode)) {
						continue;
					}
					fixtureName = Node.isStringLiteral(nameNode)
						? nameNode.getLiteralValue()
						: nameNode.getText();
					value = property.getInitializer() ?? null;
				} else if (Node.isShorthandPropertyAssignment(property)) {
					fixtureName = property.getName();
					value = property.getNameNode();
				} else {
					continue;
				}

				if (!fixtureName || !value) {
					continue;
				}

				const binding: FixtureBinding = {
					name: fixtureName,
					file: ctx.ws.rel(sourceFile.getFilePath()),
					loc: ctx.ws.loc(property),
					form: "dynamic",
				};

				let className: NameRef | null = null;
				if (
					Node.isIdentifier(value) ||
					Node.isPropertyAccessExpression(value)
				) {
					className = readNameRef(value);
					binding.form = "constructor";
				} else if (
					Node.isArrowFunction(value) ||
					Node.isFunctionExpression(value)
				) {
					className = factoryClass(value);
					binding.form = "factory";
				}

				if (!className) {
					warnings.push(
						info(
							"fixture-entry-dynamic",
							`Fixture "${fixtureName}" is bound to ${rawText(value, 60)}, which does not name a page-object class.`,
							ctx.ws.loc(value),
						),
					);
					continue;
				}

				const resolution = resolveClassRef(
					ctx.project,
					sourceFile,
					className.qualified,
					ctx.resolveOptions,
				);
				const ref = refFromResolution(resolution, ctx, className.simple);
				// `refFromResolution` keys an unresolved or non-class binding under
				// the name as written, which would put a page object in the map that
				// no declaration backs.
				if (!ref.ref || ref.external || !ref.declaration) {
					warnings.push(
						info(
							"fixture-entry-dynamic",
							`Fixture "${fixtureName}" refers to "${className.simple}", which could not be resolved to a project class.`,
							ctx.ws.loc(value),
						),
					);
					continue;
				}

				const key = keyFold(ref.ref);
				const list = byClass.get(key);
				if (list) {
					list.push(binding);
				} else {
					byClass.set(key, [binding]);
				}
				const claimed = byName.get(fixtureName);
				if (claimed !== undefined && claimed !== key) {
					// `fixture:name` can only point at one class; say which one won
					// rather than letting file order decide silently.
					warnings.push(
						info(
							"fixture-name-ambiguous",
							`Fixture "${fixtureName}" is bound to more than one page object ("${claimed}" and "${key}"); "fixture:${fixtureName}" resolves to the last one discovered.`,
							ctx.ws.loc(property),
						),
					);
				}
				byName.set(fixtureName, key);
				declarations.set(key, ref.declaration);
			}
		}
	}

	return { byClass, byName, declarations, warnings };
}

/** Convenience wrapper used by the tree builder to look one class up. */
export function fixturesForClass(
	map: FixtureMap,
	relFile: string,
	className: string,
): FixtureBinding[] {
	return map.byClass.get(keyFold(defKey(relFile, className))) ?? [];
}
