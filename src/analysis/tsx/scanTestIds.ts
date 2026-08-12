import * as path from "node:path";
import {
	type JsxAttribute,
	type JsxOpeningElement,
	type JsxSelfClosingElement,
	Node,
	type SourceFile,
	SyntaxKind,
	ts,
} from "ts-morph";
import type {
	DynamicReason,
	SourceLoc,
	TestIdOccurrence,
	TestIdValue,
} from "../types";
import { hasDefaultKeyword } from "../util/exports";
import { escapeRegExp } from "../util/paths";
import { lineAndColumnAt } from "../util/position";

export type JsxOpeningLike = JsxOpeningElement | JsxSelfClosingElement;

export interface ScannedElement {
	node: JsxOpeningLike;
	tag: string;
	nodeType: "element" | "component";
	/** Usually one value; a static ternary yields two. */
	testIds: TestIdValue[];
	component: string;
	conditional: boolean;
	repeated: boolean;
	/** `{...props}` present on this element. */
	hasSpread: boolean;
	/** Identifier spread onto this element, e.g. `props` in `{...props}`. */
	spreadNames: string[];
	/** Attribute name to value for every attribute on this element. */
	attributes: Map<string, TestIdValue[]>;
	loc: SourceLoc;
}

/**
 * Whether a JSX tag names a component rather than a host element.
 *
 * Single source of truth for the scan, the tree and anything else that has to
 * make the call. Two rules, both JSX's own: a capitalised bare tag is an
 * identifier read out of scope, and *any* dotted tag is a member expression —
 * `<icons.Button/>` reads `icons.Button` from scope however the namespace
 * segment is spelled. Judging a dotted tag by that segment made
 * `<icons.Button data-testid="Save"/>` a host element, so the id written on it
 * was inventoried as a rendered DOM attribute instead of the unproven prop it
 * is, and the tree walked past a component boundary it should have reported.
 */
export function isComponentTag(tag: string): boolean {
	return tag.includes(".") || /^[A-Z]/.test(tag);
}

/** Name standing in for a component the source does not name: the file's own. */
export function fallbackComponentName(sourceFile: SourceFile): string {
	return path.basename(sourceFile.getBaseName()).replace(/\.[jt]sx?$/, "");
}

/**
 * Nearest enclosing *named* component.
 *
 * Anonymous callbacks are skipped on purpose: an element inside
 * `cart.map((item) => …)` still belongs to the component that owns the `.map`.
 */
export function enclosingComponentName(node: Node): string {
	let current: Node | undefined = node.getParent();
	while (current) {
		if (Node.isFunctionDeclaration(current)) {
			const name = current.getName();
			if (name) {
				return name;
			}
			if (hasDefaultKeyword(current)) {
				return fallbackComponentName(current.getSourceFile());
			}
		}
		if (Node.isArrowFunction(current) || Node.isFunctionExpression(current)) {
			const parent = current.getParent();
			if (parent && Node.isVariableDeclaration(parent)) {
				return parent.getName();
			}
			if (parent && Node.isPropertyAssignment(parent)) {
				return parent.getName();
			}
		}
		if (Node.isClassDeclaration(current)) {
			return (
				current.getName() ?? fallbackComponentName(current.getSourceFile())
			);
		}
		current = current.getParent();
	}
	return fallbackComponentName(node.getSourceFile());
}

function isFunctionBoundary(node: Node): boolean {
	return (
		Node.isFunctionDeclaration(node) ||
		Node.isMethodDeclaration(node) ||
		Node.isClassDeclaration(node)
	);
}

/** `{cond && <X/>}` and `{cond ? <X/> : <Y/>}` both make the element optional. */
export function isConditionallyRendered(node: Node): boolean {
	let current: Node | undefined = node.getParent();
	while (current && !isFunctionBoundary(current)) {
		if (Node.isConditionalExpression(current)) {
			return true;
		}
		if (Node.isBinaryExpression(current)) {
			const operator = current.getOperatorToken().getKind();
			if (
				operator === SyntaxKind.AmpersandAmpersandToken ||
				operator === SyntaxKind.BarBarToken ||
				operator === SyntaxKind.QuestionQuestionToken
			) {
				return true;
			}
		}
		current = current.getParent();
	}
	return false;
}

/** Rendered inside a `.map(...)` callback, so the id repeats at runtime. */
export function isRepeated(node: Node): boolean {
	let current: Node | undefined = node.getParent();
	while (current) {
		if (Node.isCallExpression(current)) {
			const callee = current.getExpression();
			if (
				Node.isPropertyAccessExpression(callee) &&
				(callee.getName() === "map" || callee.getName() === "flatMap")
			) {
				return true;
			}
		}
		if (
			Node.isFunctionDeclaration(current) ||
			Node.isClassDeclaration(current)
		) {
			return false;
		}
		current = current.getParent();
	}
	return false;
}

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

export function readExpressionValue(expression: Node): {
	values: TestIdValue[];
	fromTernary: boolean;
} {
	const raw = expression.getText();

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

function spreadIdentifierNames(element: JsxOpeningLike): string[] {
	const names: string[] = [];
	for (const attribute of element.getAttributes()) {
		if (!Node.isJsxSpreadAttribute(attribute)) {
			continue;
		}
		const expression = attribute.getExpression();
		if (Node.isIdentifier(expression)) {
			names.push(expression.getText());
		}
	}
	return names;
}

/**
 * How ts-morph hands back the wrapper for a compiler node it already parsed.
 *
 * Not on the public surface, but it is the same call `getDescendantsOfKind`
 * makes for every node it yields, and the whole reason {@link jsxOpeningElements}
 * can do its own traversal without giving up ts-morph nodes. Named here so the
 * one place that reaches past the public API is visible; if a ts-morph major
 * ever renames it, this throws at the first scan and the equivalence spec in
 * `scanTestIds.spec.ts` fails loudly rather than the scan going quiet.
 */
interface NodeWrapper {
	_getNodeFromCompilerNode(node: ts.Node): unknown;
}

/**
 * Every JSX opening and self-closing element in the file, in source order.
 *
 * One raw `ts.forEachChild` descent rather than two `getDescendantsOfKind`
 * passes plus a sort. ts-morph's descendant iterator is a recursive generator
 * that allocates a fresh children array for every node it visits, and running
 * it twice over a repository's worth of TSX measured 334–412 ms against 63 ms
 * for this walk over the same 14,404 elements — identical results, verified
 * both by a spec and by a full-repository diff.
 *
 * Source order falls out of the descent, so the sort goes too: `forEachChild`
 * visits children in the order they were parsed.
 */
function jsxOpeningElements(sourceFile: SourceFile): JsxOpeningLike[] {
	const wrapper = sourceFile as unknown as NodeWrapper;
	const found: JsxOpeningLike[] = [];
	const visit = (node: ts.Node): void => {
		if (
			node.kind === ts.SyntaxKind.JsxOpeningElement ||
			node.kind === ts.SyntaxKind.JsxSelfClosingElement
		) {
			found.push(wrapper._getNodeFromCompilerNode(node) as JsxOpeningLike);
		}
		node.forEachChild(visit);
	};
	sourceFile.compilerNode.forEachChild(visit);
	return found;
}

/**
 * Walks every JSX opening element in a file and records what its attributes say.
 *
 * Framework-agnostic on purpose: `tag` / `component` / `nodeType` are the same
 * vocabulary a future Vue or Svelte scanner would fill in.
 */
export function scanFileElements(
	sourceFile: SourceFile,
	attribute: string,
	relFile: string,
): ScannedElement[] {
	const elements: ScannedElement[] = [];

	for (const element of jsxOpeningElements(sourceFile)) {
		const tag = element.getTagNameNode().getText();
		const attributes = new Map<string, TestIdValue[]>();
		let testIds: TestIdValue[] = [];
		let fromTernary = false;

		for (const jsxAttribute of element.getAttributes()) {
			if (!Node.isJsxAttribute(jsxAttribute)) {
				continue;
			}
			const name = jsxAttribute.getNameNode().getText();
			const read = readAttributeValue(jsxAttribute);
			if (read.values.length > 0) {
				attributes.set(name, read.values);
			}
			if (name === attribute) {
				testIds = read.values;
				fromTernary = read.fromTernary;
			}
		}

		const position = lineAndColumnAt(sourceFile, element.getStart());
		const spreadNames = spreadIdentifierNames(element);
		elements.push({
			node: element,
			tag,
			nodeType: isComponentTag(tag) ? "component" : "element",
			testIds,
			component: enclosingComponentName(element),
			conditional: fromTernary || isConditionallyRendered(element),
			repeated: isRepeated(element),
			hasSpread: spreadNames.length > 0 || hasAnySpread(element),
			spreadNames,
			attributes,
			loc: { file: relFile, line: position.line, column: position.column },
		});
	}

	return elements;
}

function hasAnySpread(element: JsxOpeningLike): boolean {
	return element
		.getAttributes()
		.some((attribute) => Node.isJsxSpreadAttribute(attribute));
}

/**
 * Flat inventory of every test id in an already-scanned element list.
 *
 * An id written on a component tag is inventoried like any other — dropping it
 * would make a page object that selects it look dead — but its `reach` is
 * `"component-prop"`, because a prop only reaches the DOM if the component
 * passes it to a host element. Proving that is the tree walk's job, not this
 * scan's, and until it is proven the scan says exactly that rather than
 * implying the id renders.
 */
export function occurrencesFromElements(
	elements: ScannedElement[],
	relFile: string,
): TestIdOccurrence[] {
	const out: TestIdOccurrence[] = [];
	for (const element of elements) {
		for (const value of element.testIds) {
			const occurrence: TestIdOccurrence = {
				value,
				file: relFile,
				loc: element.loc,
				tag: element.tag,
				component: element.component,
				reach: element.nodeType === "component" ? "component-prop" : "element",
			};
			if (element.conditional) {
				occurrence.conditional = true;
			}
			if (element.repeated) {
				occurrence.repeated = true;
			}
			out.push(occurrence);
		}
	}
	return out;
}

/** Flat inventory of every test id in one file. */
export function scanFileTestIds(
	sourceFile: SourceFile,
	attribute: string,
	relFile: string,
): TestIdOccurrence[] {
	return occurrencesFromElements(
		scanFileElements(sourceFile, attribute, relFile),
		relFile,
	);
}
