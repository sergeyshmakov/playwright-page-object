import { Node, SyntaxKind } from "ts-morph";
import type {
	DynamicReason,
	DynamicValue,
	MaybeStatic,
	RegexValue,
	StaticValue,
} from "../types";
import { unwrapTransparent } from "./ast";

export type EvalResult =
	| { ok: true; value: StaticValue }
	| { ok: false; reason: DynamicReason; text: string };

const MAX_RAW = 200;

/** Collapses newlines and runs of whitespace, then truncates for wire payloads. */
export function rawText(node: Node | undefined, max = MAX_RAW): string {
	if (!node) {
		return "";
	}
	const collapsed = node.getText().replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function fail(node: Node, reason: DynamicReason): EvalResult {
	return { ok: false, reason, text: rawText(node) };
}

/**
 * Evaluates a syntax node to a JSON value without executing anything.
 *
 * A failure at any depth fails the whole expression — half of a
 * `{ name: ... }` options object would be more misleading than an honest
 * `dynamic` marker.
 */
export function evaluateStatic(node: Node): EvalResult {
	const target = unwrapTransparent(node);

	if (Node.isStringLiteral(target)) {
		return { ok: true, value: target.getLiteralValue() };
	}
	if (Node.isNoSubstitutionTemplateLiteral(target)) {
		return { ok: true, value: target.getLiteralValue() };
	}
	if (Node.isNumericLiteral(target)) {
		return { ok: true, value: target.getLiteralValue() };
	}
	if (Node.isTrueLiteral(target)) {
		return { ok: true, value: true };
	}
	if (Node.isFalseLiteral(target)) {
		return { ok: true, value: false };
	}
	if (Node.isNullLiteral(target)) {
		return { ok: true, value: null };
	}
	if (Node.isIdentifier(target) && target.getText() === "undefined") {
		return { ok: true, value: null };
	}
	if (Node.isRegularExpressionLiteral(target)) {
		return { ok: true, value: parseRegexLiteral(target.getText()) };
	}
	if (Node.isPrefixUnaryExpression(target)) {
		const operator = target.getOperatorToken();
		const operand = unwrapTransparent(target.getOperand());
		if (
			Node.isNumericLiteral(operand) &&
			(operator === SyntaxKind.MinusToken || operator === SyntaxKind.PlusToken)
		) {
			const value = operand.getLiteralValue();
			return {
				ok: true,
				value: operator === SyntaxKind.MinusToken ? -value : value,
			};
		}
		return fail(target, "computed-expression");
	}
	if (Node.isTemplateExpression(target)) {
		return fail(target, "template-literal");
	}
	if (Node.isArrayLiteralExpression(target)) {
		const items: StaticValue[] = [];
		for (const element of target.getElements()) {
			if (Node.isSpreadElement(element)) {
				return fail(element, "spread");
			}
			const evaluated = evaluateStatic(element);
			if (!evaluated.ok) {
				return evaluated;
			}
			items.push(evaluated.value);
		}
		return { ok: true, value: items };
	}
	if (Node.isObjectLiteralExpression(target)) {
		const record: Record<string, StaticValue> = {};
		for (const property of target.getProperties()) {
			if (Node.isSpreadAssignment(property)) {
				return fail(property, "spread");
			}
			if (Node.isShorthandPropertyAssignment(property)) {
				return fail(property, "identifier-unresolved");
			}
			if (!Node.isPropertyAssignment(property)) {
				return fail(property, "unsupported-syntax");
			}
			const nameNode = property.getNameNode();
			if (Node.isComputedPropertyName(nameNode)) {
				return fail(nameNode, "computed-expression");
			}
			const key = Node.isStringLiteral(nameNode)
				? nameNode.getLiteralValue()
				: nameNode.getText();
			const initializer = property.getInitializer();
			if (!initializer) {
				return fail(property, "unsupported-syntax");
			}
			const evaluated = evaluateStatic(initializer);
			if (!evaluated.ok) {
				return evaluated;
			}
			record[key] = evaluated.value;
		}
		return { ok: true, value: record };
	}
	if (Node.isIdentifier(target)) {
		return fail(target, "identifier-unresolved");
	}
	return fail(target, "computed-expression");
}

/** Converts an {@link EvalResult} into the union stored on the wire. */
export function toMaybeStatic(result: EvalResult): MaybeStatic {
	if (result.ok) {
		return result.value;
	}
	const dynamic: DynamicValue = {
		kind: "dynamic",
		source: result.text,
		reason: result.reason,
	};
	return dynamic;
}

export function evaluateToMaybeStatic(node: Node): MaybeStatic {
	return toMaybeStatic(evaluateStatic(node));
}

export function isDynamicValue(value: MaybeStatic): value is DynamicValue {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as { kind?: unknown }).kind === "dynamic"
	);
}

export function isRegexValue(value: MaybeStatic): value is RegexValue {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as { kind?: unknown }).kind === "regex"
	);
}

/** Parses `/source/flags` text into the JSON regex encoding. */
export function parseRegexLiteral(text: string): RegexValue {
	const lastSlash = text.lastIndexOf("/");
	if (!text.startsWith("/") || lastSlash <= 0) {
		return { kind: "regex", source: text, flags: "" };
	}
	return {
		kind: "regex",
		source: text.slice(1, lastSlash),
		flags: text.slice(lastSlash + 1),
	};
}

const REGEX_META = new Set([
	"\\",
	"^",
	"$",
	".",
	"|",
	"?",
	"*",
	"+",
	"(",
	")",
	"[",
	"]",
	"{",
	"}",
]);

/**
 * Longest leading run of literal characters in a regex source, used as a cheap
 * containment probe during coverage matching. A leading `^` is skipped because
 * it constrains position, not content.
 */
export function literalPrefixOf(source: string): string | null {
	let index = source.startsWith("^") ? 1 : 0;
	let prefix = "";
	while (index < source.length) {
		const char = source[index];
		if (REGEX_META.has(char)) {
			break;
		}
		// A quantifier applies to the previous character, so drop it.
		const next = source[index + 1];
		if (next === "?" || next === "*" || next === "+" || next === "{") {
			break;
		}
		prefix += char;
		index += 1;
	}
	return prefix.length > 0 ? prefix : null;
}
