import {
	type ClassDeclaration,
	Node,
	type SourceFile,
	SyntaxKind,
} from "ts-morph";
import { info } from "../diagnostics";
import type { Diagnostic, FixtureBinding } from "../types";
import { lexicalDeclaration, unwrapTransparent } from "../util/ast";
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
	if (
		!Node.isArrowFunction(fn) &&
		!Node.isFunctionExpression(fn) &&
		!Node.isFunctionDeclaration(fn)
	) {
		return null;
	}
	const declared = fn.getBody();
	if (!declared) {
		return null;
	}
	let body: Node = declared;
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

/**
 * A factory the fixture entry *names* instead of spelling out:
 * `const makeHome = (page) => new HomePage(page)` bound as `{ home: makeHome }`
 * or as the shorthand `{ makeHome }`.
 *
 * Only a function initializer, and deliberately so. `const Alias = HomePage` is
 * an alias to a class, not a factory; following it would key a page object
 * under a name no declaration backs, which is what `fixture-entry-dynamic`
 * exists to refuse.
 */
function localFactory(
	reference: Node,
	sourceFile: SourceFile,
	name: string,
): Node | null {
	// Lexically first, and a nearer binding is not overridden by the file-level
	// one even when it turns out not to be a factory: `createFixtures` called
	// inside a function whose own `makeHome` shadows a module-level `makeHome`
	// must read the one the call actually names. A file-wide lookup read the
	// outer factory - wrong class - or found nothing and discarded a perfectly
	// static nested factory as dynamic.
	const declaration =
		lexicalDeclaration(reference, name) ??
		sourceFile.getVariableDeclaration(name) ??
		sourceFile.getFunction(name);
	if (!declaration) {
		return null;
	}
	if (Node.isFunctionDeclaration(declaration)) {
		return declaration;
	}
	if (!Node.isVariableDeclaration(declaration)) {
		return null;
	}
	const initializer = declaration.getInitializer();
	return initializer &&
		(Node.isArrowFunction(initializer) ||
			Node.isFunctionExpression(initializer))
		? initializer
		: null;
}

/**
 * `new X(…)`, or an identifier initialised from one in the same block.
 *
 * The wrappers come off through {@link unwrapTransparent} rather than a local
 * list of them. This had its own, which knew parentheses and nothing else, so
 * `page => new HomePage(page) as HomePage` was reported
 * `fixture-entry-dynamic` — the fixture metadata dropped, and with it any class
 * whose only discovery evidence was that fixture.
 *
 * `await` is unwrapped separately and deliberately: it is a runtime operation,
 * not a type-level wrapper, so it has no business in the shared helper.
 */
function constructedClass(written: Node, scope: Node | null): NameRef | null {
	const expression = unwrapTransparent(written);
	if (Node.isAwaitExpression(expression)) {
		return constructedClass(expression.getExpression(), scope);
	}
	if (Node.isNewExpression(expression)) {
		return readNameRef(expression.getExpression());
	}
	if (scope && Node.isIdentifier(expression)) {
		// Outward from the reference, nearest binding wins. Scanning the factory
		// for declarations of the name and keeping the ones whose block encloses
		// the reference is not the same thing: an outer `const result` and an
		// inner block's `const result` both enclose it, and document order then
		// picked the outer one - mapping the fixture to a class the factory never
		// returns, which is the very bug the enclosure test was meant to fix.
		const declaration = lexicalDeclaration(expression, expression.getText());
		if (declaration && Node.isVariableDeclaration(declaration)) {
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
				const named = Node.isIdentifier(value)
					? localFactory(value, sourceFile, value.getText())
					: null;
				if (named) {
					// An entry that names a factory declared beside it. Read as a
					// constructor, `resolveClassRef` resolved the *variable* and the
					// binding was thrown away as dynamic, taking the fixture metadata
					// with it - and any class discoverable only through it.
					className = factoryClass(named);
					binding.form = "factory";
				} else if (
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
