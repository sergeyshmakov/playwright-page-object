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
import { resolveClassRef } from "../util/resolve";
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

function findNewExpressionClass(node: Node): string | null {
	let found: string | null = null;
	node.forEachDescendant((descendant, traversal) => {
		if (found) {
			traversal.stop();
			return;
		}
		if (Node.isNewExpression(descendant)) {
			const expression = descendant.getExpression();
			if (Node.isIdentifier(expression)) {
				found = expression.getText();
				traversal.stop();
			} else if (Node.isPropertyAccessExpression(expression)) {
				found = expression.getName();
				traversal.stop();
			}
		}
	});
	return found;
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

				let className: string | null = null;
				if (Node.isIdentifier(value)) {
					className = value.getText();
					binding.form = "constructor";
				} else if (
					Node.isArrowFunction(value) ||
					Node.isFunctionExpression(value)
				) {
					className = findNewExpressionClass(value);
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
					className,
					ctx.resolveOptions,
				);
				const ref = refFromResolution(resolution, ctx, className);
				if (!ref.ref || ref.external) {
					warnings.push(
						info(
							"fixture-entry-dynamic",
							`Fixture "${fixtureName}" refers to "${className}", which could not be resolved to a project class.`,
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
				byName.set(fixtureName, key);
				if (ref.declaration) {
					declarations.set(key, ref.declaration);
				}
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
