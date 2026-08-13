import type {
	ArrowFunction,
	Block,
	CaseClause,
	DefaultClause,
	FunctionDeclaration,
	FunctionExpression,
	MethodDeclaration,
} from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

/**
 * A scope that holds statements directly, and so can declare a binding.
 *
 * `case` and `default` clauses carry statements without a block of their own:
 * `default: const Card = registry.Card; return <Card/>` is a scope even though
 * nothing is braced. `DefaultClause` was missing from this test, so that lookup
 * walked past the local and resolved `Card` against a module-level import of
 * the name — while the same switch written `default: { … }` was fine, because
 * the braces make a `Block`.
 *
 * Shared by both scope walks. The two of them disagreeing about what counts as
 * a scope is how the last several of these got in.
 */
export function carriesStatements(
	scope: Node,
): scope is Block | CaseClause | DefaultClause {
	return (
		Node.isBlock(scope) ||
		Node.isCaseClause(scope) ||
		Node.isDefaultClause(scope)
	);
}

/**
 * Syntax that says nothing about what an expression *is*.
 *
 * One rule, one owner. `tree.ts` states the reason it has to be one rule, and
 * states it about itself: *a predicate that disagrees with `walk` about what an
 * expression is decides the opposite thing about it.* That was written beside
 * the third byte-identical copy of the predicate — the walk's, the component
 * resolver's and the export reader's, same five kinds in the same order, none
 * of them importing the others.
 *
 * The kinds, and why each is transparent:
 *
 * - `(x)` — grouping, erased by the parser's own precedence rules.
 * - `x as T`, `<T>x` — the two spellings of the same assertion. The
 *   angle-bracket form is unparseable in `.tsx`, so a caller that only ever
 *   reads `.tsx` never meets it; a caller reading `.ts` page objects does.
 * - `x!` — a non-null assertion, a type-level claim about a value.
 * - `x satisfies T` — a type-level check that evaluates to `x`.
 *
 * What this is *not* for: peeling one specific wrapper at one specific
 * position. Several callers deliberately strip only parentheses because they
 * are descending into a known shape rather than asking "what is this
 * expression"; folding those in here would widen them by accident.
 */
export function unwrapTransparent(node: Node): Node {
	let current = node;
	while (
		Node.isParenthesizedExpression(current) ||
		Node.isAsExpression(current) ||
		Node.isNonNullExpression(current) ||
		Node.isTypeAssertion(current) ||
		Node.isSatisfiesExpression(current)
	) {
		current = current.getExpression();
	}
	return current;
}

/**
 * The nearest ancestor that is not one of those wrappers.
 *
 * The same question asked upward: `export default (Card)` puts a parenthesis
 * between the identifier and the clause that names it, so a check on the
 * immediate parent reads the declaration as not exported at all. Kept beside
 * {@link unwrapTransparent} so the two cannot answer differently about which
 * kinds are transparent.
 */
export function unwrapTransparentParent(node: Node): Node | undefined {
	let current: Node | undefined = node.getParent();
	while (
		current !== undefined &&
		(Node.isParenthesizedExpression(current) ||
			Node.isAsExpression(current) ||
			Node.isNonNullExpression(current) ||
			Node.isTypeAssertion(current) ||
			Node.isSatisfiesExpression(current))
	) {
		current = current.getParent();
	}
	return current;
}

/**
 * Whether a declaration's name node binds `name`, destructuring included.
 *
 * `const { render } = props` and `const [render] = pair` bind `render` every
 * bit as much as `const render` does. Testing only for an identifier meant a
 * destructured binding was invisible to the shadowing walk, so the call fell
 * through to a module helper of the same name — the mis-attribution this whole
 * lookup exists to prevent, reachable through a spelling instead.
 */
export function bindsName(nameNode: Node, name: string): boolean {
	if (Node.isIdentifier(nameNode)) {
		return nameNode.getText() === name;
	}
	if (
		Node.isObjectBindingPattern(nameNode) ||
		Node.isArrayBindingPattern(nameNode)
	) {
		for (const element of nameNode.getElements()) {
			if (
				Node.isBindingElement(element) &&
				bindsName(element.getNameNode(), name)
			) {
				return true;
			}
		}
	}
	return false;
}

/**
 * A binding `scope` introduces on its own header rather than inside its block.
 *
 * `for (const Card of cards)` and `catch (Card)` both scope a name to the
 * statement, and neither is a `Block`, so a walk that only inspects blocks
 * looks straight past them — and then resolves the name against whatever the
 * module imports under it.
 *
 * Returns the declaration. Callers that want the value decide what to do with
 * it: a `for…of` variable has no initializer and stays opaque, which is the
 * right answer, because unknown beats attributing some other component's
 * subtree to it.
 *
 * `includeVar` is false for callers that handle function-scoped `var` at the
 * body level instead — see {@link blockScopedBinding}'s use of it.
 */
export function headerDeclaration(
	scope: Node,
	name: string,
	includeVar = true,
): Node | null {
	if (Node.isCatchClause(scope)) {
		const declaration = scope.getVariableDeclaration();
		return declaration && bindsName(declaration.getNameNode(), name)
			? declaration
			: null;
	}
	if (
		!Node.isForStatement(scope) &&
		!Node.isForOfStatement(scope) &&
		!Node.isForInStatement(scope)
	) {
		return null;
	}
	const initializer = scope.getInitializer();
	if (
		initializer === undefined ||
		!Node.isVariableDeclarationList(initializer)
	) {
		return null;
	}
	if (!includeVar && initializer.getDeclarationKind() === "var") {
		return null;
	}
	for (const declaration of initializer.getDeclarations()) {
		if (bindsName(declaration.getNameNode(), name)) {
			return declaration;
		}
	}
	return null;
}

type FunctionLike =
	| ArrowFunction
	| FunctionExpression
	| FunctionDeclaration
	| MethodDeclaration;

function isFunctionLike(node: Node): node is FunctionLike {
	return (
		Node.isArrowFunction(node) ||
		Node.isFunctionExpression(node) ||
		Node.isFunctionDeclaration(node) ||
		Node.isMethodDeclaration(node)
	);
}

/**
 * A `var` that binds `name` anywhere inside `scope`.
 *
 * `var` is function-scoped, so `if (flag) { var Card = LocalCard; }` shadows the
 * name for the whole body — including the `return <Card/>` written outside that
 * block. A walk that only reads each enclosing statement list cannot see it, and
 * fell through to a module-level import of the name.
 *
 * `const` and `let` are deliberately not looked for here: they are block-scoped,
 * and the statement-list walk is already the right answer for them.
 */
function functionScopedVar(scope: Node, name: string): Node | null {
	if (!isFunctionLike(scope)) {
		return null;
	}
	for (const declaration of scope.getDescendantsOfKind(
		SyntaxKind.VariableDeclaration,
	)) {
		const list = declaration.getParent();
		if (
			!Node.isVariableDeclarationList(list) ||
			list.getDeclarationKind() !== "var" ||
			!bindsName(declaration.getNameNode(), name)
		) {
			continue;
		}
		// A `var` inside a *nested* function belongs to that function, not this one.
		let owner: Node | undefined = declaration.getParent();
		while (owner && !isFunctionLike(owner)) {
			owner = owner.getParent();
		}
		if (owner === scope) {
			return declaration;
		}
	}
	return null;
}

/** The parameter of `scope` that binds `name`, destructuring included. */
function parameterBinding(scope: Node, name: string): Node | null {
	if (!isFunctionLike(scope)) {
		return null;
	}
	for (const parameter of scope.getParameters()) {
		if (bindsName(parameter.getNameNode(), name)) {
			return parameter;
		}
	}
	return null;
}

/**
 * The declaration of `name` nearest to `from`, anywhere below module scope.
 *
 * For a component declared inside another component:
 *
 * ```tsx
 * function App() {
 *   function Empty() { return <div data-testid="Empty" /> }
 *   return <Empty />
 * }
 * ```
 *
 * `Empty` is a perfectly static binding, but it is not a declaration *of the
 * source file*, so the resolver - which starts from the file - reported
 * `identifier-unresolved` and the walk stopped at a boundary that is not one,
 * dropping every test id the nested component renders.
 *
 * Stops before the `SourceFile`: module scope is where the ordinary resolver
 * takes over, and it knows about exports, imports and re-export chains that
 * this walk deliberately does not.
 */
export function lexicalDeclaration(from: Node, name: string): Node | null {
	for (
		let scope = from.getParent();
		scope && !Node.isSourceFile(scope);
		scope = scope.getParent()
	) {
		// A parameter binds the name across the whole function body and shadows
		// anything the module imports or declares. It is returned rather than
		// skipped precisely because it is not a declaration a caller can expand:
		// falling through to a module-level namesake made `function Page({ Card })`
		// report the *imported* `Card`'s subtree, and the ids of a component the
		// call site may never pass. Unresolved is the honest answer, and returning
		// the parameter is what produces it.
		const parameter = parameterBinding(scope, name);
		if (parameter) {
			return parameter;
		}
		// Checked at the function boundary, after its blocks: an inner `const`
		// shadows a `var` from the same body, which is what the walk order says.
		const hoisted = functionScopedVar(scope, name);
		if (hoisted) {
			return hoisted;
		}
		// `for (const Card of cards)` and `catch (Card)` scope a name to a
		// statement that is not a block.
		const header = headerDeclaration(scope, name);
		if (header) {
			return header;
		}
		if (!carriesStatements(scope)) {
			continue;
		}
		for (const statement of scope.getStatements()) {
			// A class is a declaration like any other. Missing it sent `<Card />`
			// past a `class Card` in the body to a module-level import of the name.
			if (
				Node.isFunctionDeclaration(statement) ||
				Node.isClassDeclaration(statement)
			) {
				if (statement.getName() === name) {
					return statement;
				}
				continue;
			}
			if (!Node.isVariableStatement(statement)) {
				continue;
			}
			for (const declaration of statement
				.getDeclarationList()
				.getDeclarations()) {
				// Destructuring included. `const { Card } = registry` binds `Card`
				// exactly as `const Card = …` does, and an identifier-only test let
				// the lookup fall through to a module-level `Card` and expand an
				// unrelated component's subtree — the same blind spot
				// `blockScopedBinding` names in its own comment.
				if (bindsName(declaration.getNameNode(), name)) {
					return declaration;
				}
			}
		}
	}
	return null;
}
