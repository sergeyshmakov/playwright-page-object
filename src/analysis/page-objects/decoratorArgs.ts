import { Node, type SourceFile } from "ts-morph";
import { warn } from "../diagnostics";
import type { Diagnostic } from "../types";
import { rawText } from "../util/literal";
import {
	type RefResolution,
	resolveClassRef,
	resolvesToCallable,
} from "../util/resolve";
import { readHeritage } from "./hostKind";
import {
	type AnalysisContext,
	collectLibraryImports,
	FIXED_ARITY_DECORATORS,
	type LibraryImports,
	ROOT_DECORATORS,
} from "./libraryImports";

export type FactoryForm = "identifier" | "arrow" | "unknown";

export interface FactoryArg {
	form: FactoryForm;
	node: Node;
	/** Class the factory constructs, when statically determined. */
	className: string | null;
	resolution: RefResolution | null;
	/** `(l) => new X(l)` rather than a bare constructor reference. */
	viaInlineFactory: boolean;
	dynamic: boolean;
}

export interface SplitArgs {
	/** Arguments forwarded to the underlying `getBy*` call. */
	valueArgs: Node[];
	factory: FactoryArg | null;
	hasSpread: boolean;
	notes: string[];
	warnings: Diagnostic[];
}

function newExpressionName(node: Node): string | null {
	if (!Node.isNewExpression(node)) {
		return null;
	}
	const expression = node.getExpression();
	if (Node.isIdentifier(expression)) {
		return expression.getText();
	}
	if (Node.isPropertyAccessExpression(expression)) {
		return expression.getName();
	}
	return null;
}

/** `(l) => new X(l)` and `(l) => { return new X(l); }` both yield `"X"`. */
function inlineFactoryClassName(node: Node): string | null {
	if (!Node.isArrowFunction(node) && !Node.isFunctionExpression(node)) {
		return null;
	}
	let body: Node = node.getBody();
	if (Node.isParenthesizedExpression(body)) {
		body = body.getExpression();
	}
	if (Node.isBlock(body)) {
		const statements = body.getStatements();
		if (statements.length !== 1) {
			return null;
		}
		const [only] = statements;
		if (!Node.isReturnStatement(only)) {
			return null;
		}
		const returned = only.getExpression();
		return returned ? newExpressionName(returned) : null;
	}
	return newExpressionName(body);
}

function identifierName(node: Node): string | null {
	if (Node.isIdentifier(node)) {
		return node.getText();
	}
	if (Node.isPropertyAccessExpression(node)) {
		return node.getName();
	}
	return null;
}

/** True when `name` resolves to a class extending the library `PageObject`. */
export function resolvesToPageObjectSubclass(
	resolution: RefResolution,
	ctx: AnalysisContext,
): boolean {
	if (
		!resolution.resolved ||
		!Node.isClassDeclaration(resolution.declaration)
	) {
		return false;
	}
	const declaration = resolution.declaration;
	const imports = collectLibraryImports(declaration.getSourceFile(), ctx);
	return readHeritage(declaration, imports, ctx).inheritedApi !== null;
}

function buildIdentifierFactory(
	node: Node,
	name: string,
	sourceFile: SourceFile,
	ctx: AnalysisContext,
	notes: string[],
	warnings: Diagnostic[],
): FactoryArg {
	const resolution = resolveClassRef(
		ctx.project,
		sourceFile,
		name,
		ctx.resolveOptions,
	);
	if (resolvesToPageObjectSubclass(resolution, ctx)) {
		// selectors.ts:25-31 throws for this at decoration time.
		warnings.push(
			warn(
				"page-object-passed-as-factory",
				`"${name}" extends PageObject and cannot be passed as a factory argument; the decorator throws at class definition time. Use the accessor initializer instead: \`accessor X = new ${name}()\`.`,
				ctx.ws.loc(node),
			),
		);
	}
	const resolved = resolution.resolved;
	if (!resolved) {
		notes.push(
			`Factory argument "${name}" could not be resolved statically; treated as a constructor because it starts with an uppercase letter.`,
		);
	}
	return {
		form: "identifier",
		node,
		className: name,
		resolution,
		viaInlineFactory: false,
		dynamic: !resolved,
	};
}

/**
 * Splits a selector decorator's arguments into selector values and an optional
 * locator factory.
 *
 * Two different rules, because the runtime has two: `Selector`,
 * `SelectorByText` and `ListSelector` are declared with fixed arity 2, so the
 * factory is positionally `args[1]`. The `SelectorByRole` family is variadic
 * and picks the factory off the end with `typeof lastArg === "function"`
 * (`selectors.ts:128-131`), which no amount of static analysis can reproduce
 * exactly — hence the documented uppercase heuristic below.
 */
export function splitFactoryArg(
	canonicalName: string,
	args: Node[],
	sourceFile: SourceFile,
	_imports: LibraryImports,
	ctx: AnalysisContext,
): SplitArgs {
	const notes: string[] = [];
	const warnings: Diagnostic[] = [];

	if (args.some((argument) => Node.isSpreadElement(argument))) {
		warnings.push(
			warn(
				"dynamic-selector-arg",
				`@${canonicalName} is called with a spread argument; its selector cannot be determined statically.`,
				ctx.ws.loc(args[0] ?? sourceFile),
			),
		);
		return {
			valueArgs: [],
			factory: null,
			hasSpread: true,
			notes,
			warnings,
		};
	}

	if (canonicalName === "SelectorBy" || ROOT_DECORATORS.has(canonicalName)) {
		// Root decorators have no factory overload at all.
		return {
			valueArgs: args,
			factory: null,
			hasSpread: false,
			notes,
			warnings,
		};
	}

	if (FIXED_ARITY_DECORATORS.has(canonicalName)) {
		const candidate = args[1];
		if (!candidate) {
			return {
				valueArgs: args.slice(0, 1),
				factory: null,
				hasSpread: false,
				notes,
				warnings,
			};
		}
		return {
			valueArgs: args.slice(0, 1),
			factory: readFactory(candidate, sourceFile, ctx, notes, warnings),
			hasSpread: false,
			notes,
			warnings,
		};
	}

	// Variadic family.
	const last = args[args.length - 1];
	if (!last) {
		return { valueArgs: [], factory: null, hasSpread: false, notes, warnings };
	}
	if (!looksLikeFactory(last, sourceFile, ctx, notes)) {
		return {
			valueArgs: args,
			factory: null,
			hasSpread: false,
			notes,
			warnings,
		};
	}
	return {
		valueArgs: args.slice(0, -1),
		factory: readFactory(last, sourceFile, ctx, notes, warnings),
		hasSpread: false,
		notes,
		warnings,
	};
}

function looksLikeFactory(
	node: Node,
	sourceFile: SourceFile,
	ctx: AnalysisContext,
	notes: string[],
): boolean {
	if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
		return true;
	}
	const name = identifierName(node);
	if (!name) {
		return false;
	}
	const resolution = resolveClassRef(
		ctx.project,
		sourceFile,
		name,
		ctx.resolveOptions,
	);
	if (resolvesToCallable(resolution)) {
		return true;
	}
	if (resolution.resolved) {
		return false;
	}
	// Documented heuristic: an unresolvable trailing identifier is a factory
	// when it is capitalised (constructor convention), a value otherwise.
	const isUppercase = /^[A-Z]/.test(name);
	if (!isUppercase) {
		notes.push(
			`Trailing identifier "${name}" could not be resolved; treated as a selector value because it starts with a lowercase letter.`,
		);
	}
	return isUppercase;
}

function readFactory(
	node: Node,
	sourceFile: SourceFile,
	ctx: AnalysisContext,
	notes: string[],
	warnings: Diagnostic[],
): FactoryArg {
	if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
		const className = inlineFactoryClassName(node);
		if (className) {
			const resolution = resolveClassRef(
				ctx.project,
				sourceFile,
				className,
				ctx.resolveOptions,
			);
			return {
				form: "arrow",
				node,
				className,
				resolution,
				viaInlineFactory: true,
				dynamic: false,
			};
		}
		warnings.push(
			warn(
				"dynamic-selector-arg",
				`Inline factory ${rawText(node, 80)} does not construct a single class, so the control type is unknown.`,
				ctx.ws.loc(node),
			),
		);
		return {
			form: "arrow",
			node,
			className: null,
			resolution: null,
			viaInlineFactory: true,
			dynamic: true,
		};
	}

	const name = identifierName(node);
	if (name) {
		return buildIdentifierFactory(node, name, sourceFile, ctx, notes, warnings);
	}

	warnings.push(
		warn(
			"unresolved-factory-identifier",
			`Factory argument ${rawText(node, 80)} is not a class reference or arrow function.`,
			ctx.ws.loc(node),
		),
	);
	return {
		form: "unknown",
		node,
		className: null,
		resolution: null,
		viaInlineFactory: false,
		dynamic: true,
	};
}
