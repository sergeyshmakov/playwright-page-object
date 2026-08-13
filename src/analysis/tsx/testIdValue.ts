import type { JsxAttribute } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";
import type { DynamicReason, TestIdValue } from "../types";
import { unwrapTransparent } from "../util/ast";
import { escapeRegExp } from "../util/paths";

/**
 * Reading a test-id expression into every value it can statically render.
 *
 * The element sweep next door in `scanTestIds.ts` finds *where* an id is
 * written; this decides *what* it says. The two are separate problems: the
 * sweep is complete by construction, while a value can be a literal, a template
 * with holes the walk can expand, a pattern it can only bound, or nothing it
 * can read at all.
 */

/**
 * The id a value names outright, or `undefined` when it names none.
 *
 * The narrowing every reader of an inventory wants, written once. A pattern
 * names a *set* of ids and a dynamic value names nothing, so neither has one -
 * and before `TestIdValue` was a union, asking for `.value` on either silently
 * returned `undefined` instead of failing to compile.
 */
export function staticId(value: TestIdValue | undefined): string | undefined {
	return value?.kind === "static" ? value.value : undefined;
}

function staticValue(raw: string, text: string): TestIdValue {
	return { kind: "static", value: text, raw };
}

function dynamicValue(
	raw: string,
	reason: DynamicReason = "computed-expression",
): TestIdValue {
	return { kind: "dynamic", raw, reason };
}

type Part = { kind: "literal"; text: string } | { kind: "expr"; text: string };

/**
 * A part before expansion.
 *
 * `values` holds every string the hole is statically known to produce — one
 * entry for `${"Row"}`, one per branch for `${cond ? "A" : "B"}` — and is absent
 * for a hole nobody can read, which stays a `.+`.
 */
type PartSpec =
	| { kind: "literal"; text: string }
	| { kind: "expr"; text: string; values?: string[] };

/**
 * Ceiling on the ids one template may expand into.
 *
 * Two ternary holes is four ids, which is still a list a reader can hold; past
 * that the expansion says less about the DOM than the anchored pattern does, and
 * every extra id is another group in the coverage report. Over the cap the whole
 * template falls back to generic holes rather than expanding partially — a half
 * expanded template would claim some branches are the only ones.
 */
const MAX_TEMPLATE_VARIANTS = 4;

/**
 * Every string a template hole can statically produce, or `null` when it cannot
 * be read.
 *
 * The case this exists for is a ternary *inside* a template:
 * `` `${isAdditional ? "Additional" : "Main"}BedListItem_${index}` ``. Read as
 * one opaque hole it compiles to `^.+BedListItem_.+$`, which no probe can
 * reconcile with a selector for `MainBedListItem`, so both selectors the line
 * serves were reported dead. Both branch strings are right there in the source.
 */
function holeValues(node: Node): string[] | null {
	if (Node.isParenthesizedExpression(node)) {
		return holeValues(node.getExpression());
	}
	if (
		Node.isStringLiteral(node) ||
		Node.isNoSubstitutionTemplateLiteral(node)
	) {
		return [node.getLiteralValue()];
	}
	if (Node.isConditionalExpression(node)) {
		const whenTrue = holeValues(node.getWhenTrue());
		if (!whenTrue) {
			return null;
		}
		const whenFalse = holeValues(node.getWhenFalse());
		if (!whenFalse) {
			return null;
		}
		return [...whenTrue, ...whenFalse];
	}
	// A branch that is not a literal makes the whole hole unreadable: guessing
	// one side would report an id the other side never renders.
	return null;
}

/** Drops the expansion metadata, leaving the shape that ships on the wire. */
function toWirePart(part: PartSpec): Part {
	return part.kind === "literal"
		? { kind: "literal", text: part.text }
		: { kind: "expr", text: part.text };
}

/**
 * Adjacent literals become one.
 *
 * `${cond ? "Main" : "Additional"}BedListItem_` expands to two parts that are
 * one anchor, and `prefix` — which is what `prefixOverlap` and the containment
 * probe read — is only ever the *first* part. Left unmerged the prefix would be
 * `Main`, and a selector for `MainBedListItem` would miss it.
 */
function mergeLiterals(parts: Part[]): Part[] {
	const merged: Part[] = [];
	for (const part of parts) {
		if (part.kind === "literal" && part.text === "") {
			continue;
		}
		const last = merged[merged.length - 1];
		if (part.kind === "literal" && last?.kind === "literal") {
			merged[merged.length - 1] = {
				kind: "literal",
				text: last.text + part.text,
			};
			continue;
		}
		merged.push(part);
	}
	return merged;
}

/** One `Part[]` per combination of statically-known hole values. */
function expandParts(parts: PartSpec[]): Part[][] {
	const combinations = parts.reduce(
		(total, part) =>
			part.kind === "expr" && part.values ? total * part.values.length : total,
		1,
	);
	if (combinations > MAX_TEMPLATE_VARIANTS) {
		return [mergeLiterals(parts.map(toWirePart))];
	}
	let variants: Part[][] = [[]];
	for (const part of parts) {
		const alternatives: Part[] =
			part.kind === "expr" && part.values
				? part.values.map((text) => ({ kind: "literal" as const, text }))
				: [toWirePart(part)];
		variants = variants.flatMap((variant) =>
			alternatives.map((alternative) => [...variant, alternative]),
		);
	}
	return variants.map(mergeLiterals);
}

/**
 * Turns one interpolated expression into every value it can produce.
 *
 * More than one means the source writes a choice — `conditional: true`, exactly
 * as a ternary spelled at the top of the attribute already produces two
 * occurrences. All-literal after expansion is a static id, not a pattern: there
 * is nothing left to match loosely.
 *
 * The choice is read off the *parts*, not off the expansion. Over
 * {@link MAX_TEMPLATE_VARIANTS} the expansion collapses back to one generic
 * pattern, and judging by the variant count then reported an id that plainly
 * changes with a ternary branch as unconditional.
 */
function valuesFromParts(
	parts: PartSpec[],
	raw: string,
): { values: TestIdValue[]; fromTernary: boolean } {
	const staticChoice = parts.some(
		(part) => part.kind === "expr" && (part.values?.length ?? 0) > 1,
	);
	const variants = expandParts(parts);
	const values = variants.map((variant) => {
		if (variant.length === 0) {
			// Everything collapsed to the empty string. `^$` would be quarantined as
			// a catch-all anyway, and "the id is the empty string" is not a claim
			// worth making.
			return dynamicValue(raw);
		}
		return variant.every((part) => part.kind === "literal")
			? staticValue(raw, variant.map((part) => part.text).join(""))
			: patternFromParts(variant, raw);
	});
	return { values, fromTernary: variants.length > 1 || staticChoice };
}

function patternFromParts(parts: Part[], raw: string): TestIdValue {
	const source = `^${parts
		.map((part) => (part.kind === "literal" ? escapeRegExp(part.text) : ".+"))
		.join("")}$`;
	const first = parts[0];
	return {
		kind: "pattern",
		prefix:
			first?.kind === "literal" && first.text !== "" ? first.text : undefined,
		regex: { source, flags: "" },
		parts,
		raw,
	};
}

function partsFromTemplate(node: Node): PartSpec[] | null {
	if (!Node.isTemplateExpression(node)) {
		return null;
	}
	const parts: PartSpec[] = [];
	const head = node.getHead().getLiteralText();
	if (head !== "") {
		parts.push({ kind: "literal", text: head });
	}
	for (const span of node.getTemplateSpans()) {
		const expression = span.getExpression();
		const values = holeValues(expression);
		parts.push({
			kind: "expr",
			text: expression.getText(),
			...(values ? { values } : {}),
		});
		const literal = span.getLiteral().getLiteralText();
		if (literal !== "") {
			parts.push({ kind: "literal", text: literal });
		}
	}
	return parts;
}

function partsFromConcatenation(node: Node): PartSpec[] | null {
	if (!Node.isBinaryExpression(node)) {
		return null;
	}
	if (node.getOperatorToken().getKind() !== SyntaxKind.PlusToken) {
		return null;
	}
	const parts: PartSpec[] = [];
	const visit = (expression: Node): boolean => {
		if (
			Node.isBinaryExpression(expression) &&
			expression.getOperatorToken().getKind() === SyntaxKind.PlusToken
		) {
			return visit(expression.getLeft()) && visit(expression.getRight());
		}
		if (
			Node.isStringLiteral(expression) ||
			Node.isNoSubstitutionTemplateLiteral(expression)
		) {
			parts.push({ kind: "literal", text: expression.getLiteralValue() });
			return true;
		}
		const values = holeValues(expression);
		parts.push({
			kind: "expr",
			text: expression.getText(),
			...(values ? { values } : {}),
		});
		return true;
	};
	if (!visit(node)) {
		return null;
	}
	return parts.some((part) => part.kind === "expr") ? parts : null;
}

/**
 * Reads one JSX attribute into zero, one or several values.
 *
 * A ternary with two static branches produces two occurrences rather than one
 * `dynamic`: both ids really do exist in the DOM, just not at the same time.
 * The same holds one level down, for a ternary interpolated into a template.
 */
export function readAttributeValue(attribute: JsxAttribute): {
	values: TestIdValue[];
	fromTernary: boolean;
} {
	const initializer = attribute.getInitializer();
	if (!initializer) {
		return { values: [], fromTernary: false };
	}
	const raw = initializer.getText();

	if (Node.isStringLiteral(initializer)) {
		return {
			values: [staticValue(raw, initializer.getLiteralValue())],
			fromTernary: false,
		};
	}
	if (!Node.isJsxExpression(initializer)) {
		return {
			values: [dynamicValue(raw, "unsupported-syntax")],
			fromTernary: false,
		};
	}
	const expression = initializer.getExpression();
	if (!expression) {
		return { values: [], fromTernary: false };
	}
	return readExpressionValue(expression);
}

export function readExpressionValue(written: Node): {
	values: TestIdValue[];
	fromTernary: boolean;
} {
	// `raw` stays what the source says; the classification below reads through
	// the wrapper. `data-testid={"Root" as const}` and `{("Root")}` render the
	// literal `Root`, but every test here is a syntax test, so both came back
	// `dynamic` — a statically known id dropped from the concrete inventory,
	// which then cannot match its selector and reads as a dead one.
	const raw = written.getText();
	const expression = unwrapTransparent(written);

	if (
		Node.isStringLiteral(expression) ||
		Node.isNoSubstitutionTemplateLiteral(expression)
	) {
		return {
			values: [staticValue(raw, expression.getLiteralValue())],
			fromTernary: false,
		};
	}

	const templateParts = partsFromTemplate(expression);
	if (templateParts) {
		return valuesFromParts(templateParts, raw);
	}

	const concatParts = partsFromConcatenation(expression);
	if (concatParts) {
		return valuesFromParts(concatParts, raw);
	}

	if (Node.isConditionalExpression(expression)) {
		const whenTrue = readExpressionValue(expression.getWhenTrue());
		const whenFalse = readExpressionValue(expression.getWhenFalse());
		const values = [...whenTrue.values, ...whenFalse.values];
		if (
			values.length > 0 &&
			values.every((value) => value.kind !== "dynamic")
		) {
			return { values, fromTernary: true };
		}
		return { values: [dynamicValue(raw)], fromTernary: false };
	}

	return { values: [dynamicValue(raw)], fromTernary: false };
}
