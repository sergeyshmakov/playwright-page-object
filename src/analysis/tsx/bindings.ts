import {
	Node,
	type VariableDeclaration,
	VariableDeclarationKind,
} from "ts-morph";
import type { TestIdValue, UiNode } from "../types";
import { unwrapTransparent } from "../util/ast";
import type { ComponentDefinition } from "./componentGraph";

/**
 * The rule this walk lives by, in one sentence:
 *
 * > **Walk what is syntactically ours; flag what placement we cannot prove;
 * > never drop anything silently.**
 *
 * What that means concretely.
 *
 * **Walked.** Direct JSX children of any element, including the children of a
 * component the walk cannot expand — `<Gapped><div data-tid="X"/></Gapped>` is
 * the caller's own source whatever `Gapped` turns out to be. JSX in the props
 * of a component element, including inside object literals and arrays. One hop
 * to a variable declared in the same component body, including a call with an
 * inline function argument, which is what makes `useMemo(() => <div/>)` work
 * with no `useMemo`-specific code. A *call* to a same-file function that
 * returns JSX — `{getCheckinIcon()}` — inlined at the call site; see
 * {@link TreeBuilder.renderHelperOf}. Conditionals, logical operators,
 * `.map`/`.flatMap` with an inline callback, fragments and type-assertion
 * wrappers.
 *
 * **Flagged, not followed.** Render props the callee invokes; `cloneElement`;
 * `Children.map`; a second variable hop; module-scope or imported JSX
 * constants; `.map(renderItem)` with a non-inline callback; JSX returned by a
 * helper in another file; JSX-valued props on *host* elements (React
 * stringifies those, so walking them would claim an id renders that never
 * does); namespaced tags. Each leaves a `#unresolved` marker node and
 * downgrades `fidelity` to `"partial"`.
 *
 * **Depth counts component-definition boundaries, not DOM nesting.** Slot and
 * prop children are walked at the caller's depth with no increment — they are
 * the caller's source — exactly as host-element children already are.
 */

export interface ExpandState {
	/**
	 * Prop name to the static value the call site passed, by callee-local name.
	 *
	 * A list, non-empty, because a call site may write a static choice:
	 * `<Row rowId={big ? "A" : "B"}/>` passes two ids and both really can render.
	 * Keeping only the first made `B` vanish from the tree *and* from the
	 * inventory, so a selector for it read dead. `[0]` is the one reported as the
	 * id; the rest ride along as `testIdAlternatives`, which is exactly what the
	 * direct (unforwarded) path already does with the same shape.
	 */
	bindings: Map<string, TestIdValue[]>;
	/**
	 * Every prop name the call site wrote, dynamic and value-less ones included,
	 * by callee-local name. This is the evidence of *absence*: a name that is not
	 * here was provably not passed, which is what lets the walk say an attribute
	 * does not render rather than reporting a phantom id.
	 */
	provided: Set<string>;
	/** The call site spread an object onto the element, so unlisted props may still arrive. */
	spreadAtSite: boolean;
	/** `false` only for the tree root, whose caller is outside the analysed tree. */
	callSiteKnown: boolean;
	/** Value passed for the test-id attribute itself at the call site. */
	directAttribute: TestIdValue | null;
	conditional: boolean;
	repeated: boolean;
}

export const EMPTY_STATE: ExpandState = {
	bindings: new Map(),
	provided: new Set(),
	spreadAtSite: false,
	// The entry component has no call site inside the analysed tree. Suppressing
	// `data-tid={dataTid}` here would claim "no id renders" from no evidence at
	// all, so every absence inference is gated off at the root.
	callSiteKnown: false,
	directAttribute: null,
	conditional: false,
	repeated: false,
};

/**
 * What a name inside a component body is bound to, and what a render helper's
 * own scope does to the caller's bindings.
 *
 * Position is the whole question here: a name declared between a call and the
 * function body decides what that call means, and resolving it against a
 * same-named module helper reports one function's subtree at a site that
 * renders something else.
 */

/**
 * A prop the test-id expression reads: `testId` or `props.testId`. `container`
 * names the object half of the member form, which is how the walk knows a name
 * is a prop even when the component never destructured it.
 */
export interface PropReference {
	name: string;
	container: string | null;
}

/**
 * Whether a name a test-id expression reads is one this component takes as a
 * prop. Anything else is some other binding — a hook result, a module constant,
 * a local — and says nothing at all about what the call site passed.
 *
 * `props.testId` qualifies by construction: `props` *is* the parameter, so every
 * member read off it is a prop whether or not the component destructured it
 * anywhere.
 *
 * Shared by both directions on purpose. Asking it before *denying* an id but not
 * before *asserting* one is exactly backwards: a wrong denial hides a selector,
 * a wrong assertion invents one and the coverage report then treats the
 * invention as proven.
 */
export function declaresProp(
	reference: PropReference,
	owner: ComponentDefinition,
): boolean {
	return (
		owner.propNames.includes(reference.name) ||
		owner.propAliases.has(reference.name) ||
		owner.propDefaults.has(reference.name) ||
		(reference.container !== null &&
			owner.spreadSourceNames.includes(reference.container))
	);
}

/** Tags the top level of a passed expression; descendants keep proven placement. */
export function withPlacement(
	nodes: UiNode[],
	placement: { kind: "slot" | "prop"; name: string },
): UiNode[] {
	for (const node of nodes) {
		node.placement = placement;
	}
	return nodes;
}

/** A same-file function a call site names, plus the names its parameters bind. */
export interface RenderHelper {
	fn: Node;
	parameters: string[];
	/** Declared inside the component body, so it closes over the component's props. */
	nested: boolean;
}

/**
 * Every name a function's parameter list binds, destructuring included.
 *
 * Read off the binding names rather than off the parameter text so that
 * `({ testId, ...rest }: Props)` contributes `testId` and `rest` and not the
 * type annotation.
 */
export function parameterNames(fn: Node): string[] {
	if (
		!Node.isArrowFunction(fn) &&
		!Node.isFunctionExpression(fn) &&
		!Node.isFunctionDeclaration(fn)
	) {
		return [];
	}
	const names: string[] = [];
	const collect = (name: Node): void => {
		if (Node.isIdentifier(name)) {
			names.push(name.getText());
			return;
		}
		if (Node.isObjectBindingPattern(name) || Node.isArrayBindingPattern(name)) {
			for (const element of name.getElements()) {
				if (Node.isBindingElement(element)) {
					collect(element.getNameNode());
				}
			}
		}
	};
	for (const parameter of fn.getParameters()) {
		collect(parameter.getNameNode());
	}
	return names;
}

/**
 * The call-site state a render helper's body is walked with.
 *
 * A helper *parameter* is not a prop, and the two live in the same namespace as
 * far as `resolveSiteValue` is concerned. Removing the name from `bindings`
 * stops the component's own call-site value from being read as this
 * parameter's; adding it to `provided` — the evidence of absence — stops
 * `provablyAbsent` from concluding the opposite, that the attribute renders
 * nothing. What is left is the honest answer: unknown, reported dynamic,
 * exactly as the flat inventory reports it.
 */
export function shadowParameters(
	state: ExpandState,
	names: string[],
): ExpandState {
	if (names.length === 0) {
		return state;
	}
	const bindings = new Map(state.bindings);
	const provided = new Set(state.provided);
	for (const name of names) {
		bindings.delete(name);
		provided.add(name);
	}
	return { ...state, bindings, provided };
}

/**
 * The state a helper declared *outside* the component body is walked with.
 *
 * {@link shadowParameters} removes the names a helper's parameters bind, which
 * is the whole story for a helper written inside the component: everything it
 * did not shadow really is the component's own scope. A module-scope function
 * closes over nothing of the kind. Its identifiers resolve to module scope, and
 * walking it with the component's call-site state read them as the component's
 * props anyway — with no parameters to shadow, a zero-argument
 * `function renderRow() { return <div data-testid={rowId}/> }` was handed the
 * caller's `rowId` verbatim and reported it as the id that renders.
 *
 * Clearing `bindings` is half of it; `callSiteKnown: false` is the other half,
 * for the same reason it is false at the root. Without it the empty `provided`
 * set becomes positive evidence of *absence*, and the walk swaps one wrong
 * answer for its mirror image — "no id renders here" asserted from a scope it
 * cannot see. `conditional` and `repeated` are kept: they describe the position
 * the call sits at, which is the caller's fact, not the callee's.
 */
export function detachFromCallSite(state: ExpandState): ExpandState {
	return {
		...state,
		bindings: new Map(),
		provided: new Set(),
		spreadAtSite: false,
		callSiteKnown: false,
		directAttribute: null,
	};
}

/**
 * Whether a variable declaration shadows its name across the whole function
 * body, rather than inside one block of it.
 *
 * `const` and `let` are block-scoped: a declaration nested in an `if` or a loop
 * is invisible to the statements around it, so it cannot be what a call written
 * outside that block resolves to. `var` is function-scoped and does shadow the
 * body, which is why the kind is checked rather than assumed.
 */
export function shadowsWholeBody(
	declaration: VariableDeclaration,
	fn: Node,
): boolean {
	// The declaration *list*, not the statement: a `for (var i = 0; ...)`
	// initializer is a list with no enclosing statement, so requiring one missed
	// the `var` form entirely - and `var` is exactly the kind that does shadow
	// the whole body.
	const list = declaration.getParent();
	if (
		Node.isVariableDeclarationList(list) &&
		list.getDeclarationKind() === VariableDeclarationKind.Var
	) {
		return true;
	}
	const statement = declaration.getVariableStatement();
	if (!statement) {
		return false;
	}
	const body =
		Node.isFunctionDeclaration(fn) ||
		Node.isFunctionExpression(fn) ||
		Node.isArrowFunction(fn)
			? fn.getBody()
			: undefined;
	return body !== undefined && statement.getParent() === body;
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
function bindsName(nameNode: Node, name: string): boolean {
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
 * `for (const render of rows)` and `catch (render)` both scope a name to the
 * statement, and neither is a `Block`, so a walk that only inspects blocks
 * looks straight past them.
 *
 * Returns the initializer where there is one and the declaration otherwise —
 * the same rule {@link blockScopedBinding} uses, and for the same reason. A
 * `for (let render = () => <b/>; …)` really does declare a helper, while a
 * `for…of` variable has no initializer and stays opaque, which is the right
 * answer: the call is shadowed by a value the walk cannot follow, and unknown
 * beats attributing a module helper's subtree to it.
 */
function headerBinding(scope: Node, name: string): Node | null {
	if (Node.isCatchClause(scope)) {
		const declaration = scope.getVariableDeclaration();
		if (declaration && bindsName(declaration.getNameNode(), name)) {
			return declaration;
		}
		return null;
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
	// `var` is function-scoped; `shadowsWholeBody` owns it at the body level.
	if (initializer.getDeclarationKind() === VariableDeclarationKind.Var) {
		return null;
	}
	for (const declaration of initializer.getDeclarations()) {
		if (bindsName(declaration.getNameNode(), name)) {
			// A destructured binding lands here too, and its initializer is the
			// object being destructured — not a function, so opaque, which is what
			// following one element of a pattern would have to guess at anyway.
			return declaration.getInitializer() ?? declaration;
		}
	}
	return null;
}

/**
 * A declaration of `name` in a block between the call site and the component
 * body, or `null` when the nearest binding is not block-scoped.
 *
 * Only the levels *below* the function body: `helperIndexOf` already owns the
 * body level, where a declaration shadows every call in the component no matter
 * where it is written. Here position is the whole question, so the walk starts
 * at the call and stops at the body.
 *
 * `var` is deliberately not consulted - it is function-scoped, so
 * {@link shadowsWholeBody} has already accounted for it at the body level.
 * Returns the initializer (or the declaration, for a hoisted `function`) so the
 * caller can decide whether it is a helper or an opaque value.
 */
export function blockScopedBinding(
	from: Node,
	name: string,
	body: Node,
): Node | null {
	for (let scope = from.getParent(); scope; scope = scope.getParent()) {
		if (scope === body) {
			return null;
		}
		// A binding on the *header* of the enclosing statement, which has no block
		// of its own to hold it: `for (const render of rows)` and `catch (render)`.
		// Skipping these let the call fall through to a same-named module helper
		// and report that function's subtree — the exact mis-attribution the
		// block case exists to prevent, one syntax away.
		const header = headerBinding(scope, name);
		if (header) {
			return header;
		}
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
			const list = statement.getDeclarationList();
			if (list.getDeclarationKind() === VariableDeclarationKind.Var) {
				continue;
			}
			for (const declaration of list.getDeclarations()) {
				// Destructuring included: `const { render } = props` shadows the name
				// exactly as `const render` does, and the identifier-only test used
				// here had the same blind spot the statement headers did.
				if (bindsName(declaration.getNameNode(), name)) {
					return declaration.getInitializer() ?? declaration;
				}
			}
		}
	}
	return null;
}

/** Whether `node` is written somewhere inside `container`. */
export function isLexicallyInside(node: Node, container: Node): boolean {
	let current: Node | undefined = node.getParent();
	while (current) {
		if (current === container) {
			return true;
		}
		current = current.getParent();
	}
	return false;
}

/**
 * Whether an expression is a function written right here.
 *
 * Unwrapped first: `renderItem={((i) => <li/>) as never}` is the same render
 * prop as `renderItem={(i) => <li/>}`, and testing the wrapper reported the
 * `<li>` as UI rendered at this position when the callee decides whether it
 * runs at all.
 */
export function isInlineFunction(node: Node): boolean {
	const inner = unwrapTransparent(node);
	return Node.isArrowFunction(inner) || Node.isFunctionExpression(inner);
}

/** Whether an expression syntactically contains JSX anywhere inside it. */
export function containsJsx(node: Node): boolean {
	if (isJsxNode(node)) {
		return true;
	}
	return node.getFirstDescendant(isJsxNode) !== undefined;
}

function isJsxNode(node: Node): boolean {
	return (
		Node.isJsxElement(node) ||
		Node.isJsxSelfClosingElement(node) ||
		Node.isJsxFragment(node)
	);
}

/** Nearest enclosing function, mirroring `componentReturnExpressions`. */
export function enclosingFunctionOf(node: Node): Node | undefined {
	let current: Node | undefined = node.getParent();
	while (current) {
		if (
			Node.isFunctionDeclaration(current) ||
			Node.isArrowFunction(current) ||
			Node.isFunctionExpression(current) ||
			Node.isMethodDeclaration(current)
		) {
			return current;
		}
		current = current.getParent();
	}
	return undefined;
}

/**
 * `testId` and `props.testId` both bind; anything else is out of scope for v1.
 *
 * The member form only counts when its object half is the component's own props
 * parameter (`props`, or whatever `({ a, ...rest })` named the rest element).
 * Accepting any dotted expression would read `data-testid={item.id}` inside a
 * `.map` as the prop `id` and bind it to whatever a call site passed under that
 * name — a wrong id reported as proven, which is the worst answer available.
 */
export function propReferenceIn(
	raw: string,
	owner: ComponentDefinition,
): PropReference | null {
	const trimmed = raw.trim();
	if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
		return { name: trimmed, container: null };
	}
	const member = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(trimmed);
	if (!member) {
		return null;
	}
	const container = member[1];
	// `props` by name as well, for a component that reads `props.x` without ever
	// naming the parameter in a way `readProps` recorded.
	return container === "props" || owner.spreadSourceNames.includes(container)
		? { name: member[2], container }
		: null;
}
