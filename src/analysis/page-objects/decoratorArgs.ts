import { Node, type SourceFile } from "ts-morph";
import { warn } from "../diagnostics";
import type { Diagnostic } from "../types";
import { unwrapTransparent } from "../util/ast";
import { rawText } from "../util/literal";
import {
	type NameRef,
	type RefResolution,
	readNameRef,
	resolveClassRef,
	resolvesToCallable,
} from "../util/resolve";
import { type ClassLike, readHeritage } from "./hostKind";
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

function newExpressionName(node: Node): NameRef | null {
	if (!Node.isNewExpression(node)) {
		return null;
	}
	return readNameRef(node.getExpression());
}

/** `(l) => new X(l)` and `(l) => { return new X(l); }` both yield `"X"`. */
function inlineFactoryClassName(node: Node): NameRef | null {
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

/**
 * True when `name` resolves to a class extending the library `PageObject`.
 *
 * `const Ctrl = class extends PageObject {}` throws at decoration time exactly
 * like the declaration form, so the class-expression shape has to be checked
 * too — the runtime's `PageObject.isClass` does not care how it was written.
 */
export function resolvesToPageObjectSubclass(
	resolution: RefResolution,
	ctx: AnalysisContext,
): boolean {
	if (!resolution.resolved) {
		return false;
	}
	const declaration = heritageBearingClass(resolution.declaration);
	if (!declaration) {
		return false;
	}
	const imports = collectLibraryImports(declaration.getSourceFile(), ctx);
	return readHeritage(declaration, imports, ctx).inheritedApi !== null;
}

/** The class node whose `extends` clause can be walked, if there is one. */
function heritageBearingClass(node: Node): ClassLike | null {
	if (Node.isClassDeclaration(node) || Node.isClassExpression(node)) {
		return node;
	}
	if (Node.isVariableDeclaration(node)) {
		const initializer = node.getInitializer();
		if (initializer && Node.isClassExpression(initializer)) {
			return initializer;
		}
	}
	return null;
}

function buildIdentifierFactory(
	node: Node,
	name: NameRef,
	sourceFile: SourceFile,
	ctx: AnalysisContext,
	notes: string[],
	warnings: Diagnostic[],
): FactoryArg {
	const resolution = resolveClassRef(
		ctx.project,
		sourceFile,
		name.qualified,
		ctx.resolveOptions,
	);
	if (resolvesToPageObjectSubclass(resolution, ctx)) {
		// selectors.ts:25-31 throws for this at decoration time.
		warnings.push(
			warn(
				"page-object-passed-as-factory",
				`"${name.simple}" extends PageObject and cannot be passed as a factory argument; the decorator throws at class definition time. Use the accessor initializer instead: \`accessor X = new ${name.simple}()\`.`,
				ctx.ws.loc(node),
			),
		);
	}
	const resolved = resolution.resolved;
	if (!resolved) {
		notes.push(
			`Factory argument "${name.simple}" could not be resolved statically; treated as a constructor because it starts with an uppercase letter.`,
		);
	}
	// A plain function factory (`function makeControl(l) { … }`) is callable but
	// is not a class: naming it as the control type would invent a
	// `file#makeControl` graph node for something the runtime only ever calls.
	if (resolved && resolution.kind !== "class") {
		notes.push(
			`Factory argument "${name.simple}" resolves to a ${resolution.kind}, not a class, so the control type it returns is not statically known.`,
		);
		return {
			form: "identifier",
			node,
			className: null,
			resolution: null,
			viaInlineFactory: false,
			dynamic: true,
		};
	}
	return {
		form: "identifier",
		node,
		className: name.simple,
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
	written: Node,
	sourceFile: SourceFile,
	ctx: AnalysisContext,
	notes: string[],
): boolean {
	// `@Selector("Save", Control as any)` hands the decorator the same
	// constructor at runtime. Both tests below are syntax tests, so the wrapper
	// made the fixed-arity form report an unresolved factory and let the
	// variadic form mistake it for another selector argument.
	const node = unwrapTransparent(written);
	if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
		return true;
	}
	const name = readNameRef(node);
	if (!name) {
		return false;
	}
	const resolution = resolveClassRef(
		ctx.project,
		sourceFile,
		name.qualified,
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
	const isUppercase = /^[A-Z]/.test(name.simple);
	if (!isUppercase) {
		notes.push(
			`Trailing identifier "${name.simple}" could not be resolved; treated as a selector value because it starts with a lowercase letter.`,
		);
	}
	return isUppercase;
}

function readFactory(
	written: Node,
	sourceFile: SourceFile,
	ctx: AnalysisContext,
	notes: string[],
	warnings: Diagnostic[],
): FactoryArg {
	// Unwrapped on the same terms as `looksLikeFactory`: the two have to agree
	// about what the argument is, or one admits a factory the other cannot read.
	const node = unwrapTransparent(written);
	if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
		const className = inlineFactoryClassName(node);
		if (className) {
			const resolution = resolveClassRef(
				ctx.project,
				sourceFile,
				className.qualified,
				ctx.resolveOptions,
			);
			return {
				form: "arrow",
				node,
				className: className.simple,
				resolution,
				// `(l) => new MissingControl(l)` names a class that does not exist:
				// the graph node would be a fiction, so say so.
				viaInlineFactory: true,
				dynamic: !resolution.resolved,
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

	const name = readNameRef(node);
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
