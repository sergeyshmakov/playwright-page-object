import { Node } from "ts-morph";

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
		if (!Node.isBlock(scope) && !Node.isCaseClause(scope)) {
			continue;
		}
		for (const statement of scope.getStatements()) {
			if (Node.isFunctionDeclaration(statement)) {
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
				const nameNode = declaration.getNameNode();
				if (Node.isIdentifier(nameNode) && nameNode.getText() === name) {
					return declaration;
				}
			}
		}
	}
	return null;
}
