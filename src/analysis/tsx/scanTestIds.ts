import * as path from "node:path";
import {
	type JsxAttribute,
	type JsxOpeningElement,
	type JsxSelfClosingElement,
	Node,
	type SourceFile,
	SyntaxKind,
} from "ts-morph";
import type { SourceLoc, TestIdOccurrence, TestIdValue } from "../types";
import { escapeRegExp } from "../util/paths";

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

function isComponentTag(tag: string): boolean {
	const head = tag.split(".")[0];
	return /^[A-Z]/.test(head);
}

function fallbackComponentName(sourceFile: SourceFile): string {
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
			if (current.isDefaultExport()) {
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

function staticValue(raw: string, text: string): TestIdValue {
	return { kind: "static", value: text, raw };
}

function dynamicValue(
	raw: string,
	reason: TestIdValue["reason"] = "computed-expression",
): TestIdValue {
	return { kind: "dynamic", raw, reason };
}

type Part = { kind: "literal"; text: string } | { kind: "expr"; text: string };

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

function partsFromTemplate(node: Node): Part[] | null {
	if (!Node.isTemplateExpression(node)) {
		return null;
	}
	const parts: Part[] = [];
	const head = node.getHead().getLiteralText();
	if (head !== "") {
		parts.push({ kind: "literal", text: head });
	}
	for (const span of node.getTemplateSpans()) {
		parts.push({ kind: "expr", text: span.getExpression().getText() });
		const literal = span.getLiteral().getLiteralText();
		if (literal !== "") {
			parts.push({ kind: "literal", text: literal });
		}
	}
	return parts;
}

function partsFromConcatenation(node: Node): Part[] | null {
	if (!Node.isBinaryExpression(node)) {
		return null;
	}
	if (node.getOperatorToken().getKind() !== SyntaxKind.PlusToken) {
		return null;
	}
	const parts: Part[] = [];
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
		parts.push({ kind: "expr", text: expression.getText() });
		return true;
	};
	if (!visit(node)) {
		return null;
	}
	return parts.some((part) => part.kind === "expr") ? parts : null;
}

/**
 * Reads one JSX attribute into zero, one or two values.
 *
 * A ternary with two static branches produces two occurrences rather than one
 * `dynamic`: both ids really do exist in the DOM, just not at the same time.
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
		if (templateParts.every((part) => part.kind === "literal")) {
			return {
				values: [
					staticValue(raw, templateParts.map((part) => part.text).join("")),
				],
				fromTernary: false,
			};
		}
		return {
			values: [patternFromParts(templateParts, raw)],
			fromTernary: false,
		};
	}

	const concatParts = partsFromConcatenation(expression);
	if (concatParts) {
		return { values: [patternFromParts(concatParts, raw)], fromTernary: false };
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
	const openings: JsxOpeningLike[] = [
		...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
		...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
	];
	openings.sort((a, b) => a.getStart() - b.getStart());

	for (const element of openings) {
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

		const position = sourceFile.getLineAndColumnAtPos(element.getStart());
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

/** Flat inventory of every test id in one file. */
export function scanFileTestIds(
	sourceFile: SourceFile,
	attribute: string,
	relFile: string,
): TestIdOccurrence[] {
	const out: TestIdOccurrence[] = [];
	for (const element of scanFileElements(sourceFile, attribute, relFile)) {
		for (const value of element.testIds) {
			const occurrence: TestIdOccurrence = {
				value,
				file: relFile,
				loc: element.loc,
				tag: element.tag,
				component: element.component,
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
