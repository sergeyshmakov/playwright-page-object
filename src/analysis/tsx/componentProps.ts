import { Node, SyntaxKind } from "ts-morph";
import type { TestIdValue } from "../types";
import type { ComponentFunction } from "./componentGraph";
import { readExpressionValue } from "./scanTestIds";

/**
 * What a component declares it takes, what it defaults, and what it forwards.
 *
 * Separate from resolving a tag to a definition: this reads the *signature* of
 * a component the walk has already found, which is what decides whether an id
 * passed as a prop can be proven to reach a host element.
 */

/**
 * The prop name a destructuring element reads, as a caller writes it in JSX.
 *
 * The quotes in `({ "data-testid": id })` are source syntax, not part of the
 * name: keeping them would record an alias key no call site can ever match and
 * would put `"data-testid"` — quotes and all — in the reported `propNames`. A
 * computed key names no single prop at all, so it yields `null` and the binding
 * is left out rather than recorded under its bracketed source text.
 */
function propNameOf(
	nameNode: Node | undefined,
	fallback: string,
): string | null {
	if (!nameNode) {
		return fallback;
	}
	if (Node.isComputedPropertyName(nameNode)) {
		return null;
	}
	if (
		Node.isStringLiteral(nameNode) ||
		Node.isNoSubstitutionTemplateLiteral(nameNode)
	) {
		return nameNode.getLiteralValue();
	}
	return nameNode.getText();
}

interface PropsRead {
	propNames: string[];
	spreadSourceNames: string[];
	propAliases: Map<string, string>;
	propDefaults: Map<string, TestIdValue>;
}

/**
 * What a parameter default is worth as an answer to "what renders here".
 *
 * Exactly one statically-known value is that answer. Anything else — a call, a
 * ternary between two literals, a template with a hole — renders *something*
 * the walk cannot name, and the honest record of that is a `dynamic` marker
 * carrying the source text. Recording the first branch of a choice claimed one
 * id was the default when the other one is just as real.
 */
function defaultValueOf(initializer: Node): TestIdValue {
	const { values } = readExpressionValue(initializer);
	const [only] = values;
	return values.length === 1 && only.kind !== "dynamic"
		? only
		: {
				kind: "dynamic",
				raw: initializer.getText(),
				reason: "computed-expression",
			};
}

/**
 * Reads the component's props parameter.
 *
 * `propNames` holds the *prop* names as a caller writes them in JSX. For
 * `({ testId: id })` that is `testId`, while the body refers to `id` — the
 * alias map carries that hop so a call-site value can still be bound.
 */
export function readProps(fn: ComponentFunction): PropsRead {
	const empty: PropsRead = {
		propNames: [],
		spreadSourceNames: [],
		propAliases: new Map(),
		propDefaults: new Map(),
	};
	const [parameter] = fn.getParameters();
	if (!parameter) {
		return empty;
	}
	const nameNode = parameter.getNameNode();
	if (Node.isObjectBindingPattern(nameNode)) {
		const propNames: string[] = [];
		const spreadSourceNames: string[] = [];
		const propAliases = new Map<string, string>();
		const propDefaults = new Map<string, TestIdValue>();
		for (const element of nameNode.getElements()) {
			const local = element.getName();
			if (element.getDotDotDotToken()) {
				spreadSourceNames.push(local);
				continue;
			}
			const propName = propNameOf(element.getPropertyNameNode(), local);
			if (propName === null) {
				continue;
			}
			propNames.push(propName);
			if (propName !== local) {
				propAliases.set(local, propName);
			}
			const initializer = element.getInitializer();
			if (initializer) {
				propDefaults.set(local, defaultValueOf(initializer));
			}
		}
		return { propNames, spreadSourceNames, propAliases, propDefaults };
	}
	if (Node.isIdentifier(nameNode)) {
		return { ...empty, spreadSourceNames: [nameNode.getText()] };
	}
	return empty;
}

export function forwardsSpread(
	fn: ComponentFunction,
	sources: string[],
): boolean {
	if (sources.length === 0) {
		return false;
	}
	for (const spread of fn.getDescendantsOfKind(SyntaxKind.JsxSpreadAttribute)) {
		const expression = spread.getExpression();
		if (
			Node.isIdentifier(expression) &&
			sources.includes(expression.getText())
		) {
			return true;
		}
	}
	return false;
}
