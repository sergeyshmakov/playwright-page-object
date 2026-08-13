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

// The value reader lives next door. Re-exported so the three engine
// modules that read an expression, and this module's own sweep, keep one
// import path.
import { readAttributeValue } from "./testIdValue";

export {
	readAttributeValue,
	readExpressionValue,
	staticId,
} from "./testIdValue";

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
