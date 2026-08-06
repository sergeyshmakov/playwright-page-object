import {
	type ArrowFunction,
	type FunctionDeclaration,
	type FunctionExpression,
	Node,
	type Project,
	type SourceFile,
	SyntaxKind,
} from "ts-morph";
import type {
	ComponentInfo,
	SourceLoc,
	TestIdValue,
	UiUnresolvedReason,
} from "../types";
import { defKey } from "../util/paths";
import {
	type RefResolution,
	type ResolveOptions,
	resolveIdentifier,
} from "../util/resolve";
import { isWorkspaceLocal } from "../util/workspaceRoot";
import type { Workspace } from "../workspace";
import { fallbackComponentName, readExpressionValue } from "./scanTestIds";

export type ComponentFunction =
	| FunctionDeclaration
	| ArrowFunction
	| FunctionExpression;

export interface ComponentDefinition {
	id: string;
	name: string;
	file: string;
	sourceFile: SourceFile;
	fn: ComponentFunction;
	loc: SourceLoc;
	/** Destructured prop names, `[]` when the parameter is a plain identifier. */
	propNames: string[];
	/** Local binding name to prop name for `({ testId: id })`-style aliases. */
	propAliases: Map<string, string>;
	/**
	 * Local binding name to the statically-known default it declares
	 * (`{ testId = "Row" }`). A dynamic default is left out: the point of the map
	 * is to answer "what renders when the call site passes nothing", and an
	 * unreadable default answers nothing.
	 */
	propDefaults: Map<string, TestIdValue>;
	/** `rest` in `({ a, ...rest })`, or the whole parameter name (`props`). */
	spreadSourceNames: string[];
	forwardsSpread: boolean;
	exportKind: "default" | "named";
}

/**
 * Subset of {@link UiUnresolvedReason} a tag resolution can produce. Typed
 * narrowly so the tree can copy it onto a node without widening the wire
 * vocabulary back to `string`.
 */
export type ComponentUnresolvedReason = Extract<
	UiUnresolvedReason,
	"identifier-unresolved" | "namespaced-component" | "not-a-function-component"
>;

export type ComponentResolution =
	| { kind: "local"; definition: ComponentDefinition }
	| { kind: "external"; module: string }
	| { kind: "unresolved"; reason: ComponentUnresolvedReason };

function componentFunctionOf(node: Node): ComponentFunction | null {
	if (Node.isFunctionDeclaration(node)) {
		return node;
	}
	if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
		return node;
	}
	if (Node.isVariableDeclaration(node)) {
		const initializer = node.getInitializer();
		if (
			initializer &&
			(Node.isArrowFunction(initializer) ||
				Node.isFunctionExpression(initializer))
		) {
			return initializer;
		}
	}
	return null;
}

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
 * Reads the component's props parameter.
 *
 * `propNames` holds the *prop* names as a caller writes them in JSX. For
 * `({ testId: id })` that is `testId`, while the body refers to `id` — the
 * alias map carries that hop so a call-site value can still be bound.
 */
function readProps(fn: ComponentFunction): PropsRead {
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
				const [value] = readExpressionValue(initializer).values;
				if (value && value.kind !== "dynamic") {
					propDefaults.set(local, value);
				}
			}
		}
		return { propNames, spreadSourceNames, propAliases, propDefaults };
	}
	if (Node.isIdentifier(nameNode)) {
		return { ...empty, spreadSourceNames: [nameNode.getText()] };
	}
	return empty;
}

function forwardsSpread(fn: ComponentFunction, sources: string[]): boolean {
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

/** `export default () => …`, `export default function () {}`, `export default class {}`. */
function isDefaultExportExpression(node: Node): boolean {
	const parent = node.getParent();
	return (
		parent !== undefined &&
		Node.isExportAssignment(parent) &&
		!parent.isExportEquals()
	);
}

/**
 * The name the component declares for itself, or `null` when it declares none.
 *
 * A directly default-exported arrow has no name of its own, and the local alias
 * an importer happened to choose is not one: `import Alpha from "./Card"` and
 * `import Beta from "./Card"` would otherwise mint two different definition ids
 * for one component. The file basename stands in, which is what
 * {@link collectComponents} and the element scanner already use for the very
 * same declaration.
 */
function declaredNameOf(declaration: Node): string | null {
	if (
		Node.isFunctionDeclaration(declaration) ||
		Node.isFunctionExpression(declaration) ||
		Node.isVariableDeclaration(declaration)
	) {
		const own = declaration.getName();
		if (own) {
			return own;
		}
	}
	if (
		isDefaultExportExpression(declaration) ||
		(Node.isFunctionDeclaration(declaration) && declaration.isDefaultExport())
	) {
		return fallbackComponentName(declaration.getSourceFile());
	}
	return null;
}

function exportKindOf(node: Node, name: string): "default" | "named" {
	if (Node.isFunctionDeclaration(node) && node.isDefaultExport()) {
		return "default";
	}
	if (isDefaultExportExpression(node)) {
		return "default";
	}
	const sourceFile = node.getSourceFile();
	for (const assignment of sourceFile.getExportAssignments()) {
		const expression = assignment.getExpression();
		if (Node.isIdentifier(expression) && expression.getText() === name) {
			return "default";
		}
	}
	const variable = sourceFile.getVariableDeclaration(name);
	if (variable?.isDefaultExport()) {
		return "default";
	}
	return "named";
}

/**
 * Builds the definition of a component from its declaration.
 *
 * `name` is only a fallback for a declaration that names nothing and stands for
 * nothing: everything that has an identity of its own — a declared name, or an
 * anonymous default export standing in for its file — keeps it, so the same
 * component gets the same id no matter which call site was being resolved.
 */
export function buildDefinition(
	ws: Workspace,
	declaration: Node,
	name: string,
): ComponentDefinition | null {
	const fn = componentFunctionOf(declaration);
	if (!fn) {
		return null;
	}
	const sourceFile = declaration.getSourceFile();
	const file = ws.rel(sourceFile.getFilePath());
	const { propNames, spreadSourceNames, propAliases, propDefaults } =
		readProps(fn);
	// Prefer the declared name over the local alias at the import site, so
	// `import CartItemComponent from "./CartItem"` still reports `CartItem`.
	const declaredName = declaredNameOf(declaration) ?? name;
	const exportKind = exportKindOf(declaration, declaredName);
	const position = sourceFile.getLineAndColumnAtPos(declaration.getStart());
	return {
		id: defKey(file, exportKind === "default" ? "default" : declaredName),
		name: declaredName,
		file,
		sourceFile,
		fn,
		loc: { file, line: position.line, column: position.column },
		propNames,
		propAliases,
		propDefaults,
		spreadSourceNames,
		forwardsSpread: forwardsSpread(fn, spreadSourceNames),
		exportKind,
	};
}

/**
 * Resolves a JSX tag to its component definition.
 *
 * Same syntax-first strategy as the page-object resolver. A definition in an
 * installed dependency is rejected outright — a `<Button>` from a published
 * design system is a boundary the scanner reports rather than crosses — but a
 * workspace package *linked through* `node_modules` is not one: npm, yarn and
 * pnpm all publish local packages there as symlinks or directory junctions, and
 * judging them by the link path turns every first-party component into an
 * external boundary.
 */
export function resolveComponentRef(
	ws: Workspace,
	project: Project,
	sourceFile: SourceFile,
	tagName: string,
	options?: ResolveOptions,
): ComponentResolution {
	const head = tagName.split(".")[0];
	const resolution: RefResolution = resolveIdentifier(
		project,
		sourceFile,
		head,
		options,
	);

	if (!resolution.resolved) {
		if (resolution.external) {
			return { kind: "external", module: resolution.module };
		}
		return { kind: "unresolved", reason: "identifier-unresolved" };
	}
	if (!isWorkspaceLocal(project, resolution.sourceFile.getFilePath())) {
		return { kind: "external", module: "node_modules" };
	}
	if (tagName.includes(".")) {
		return { kind: "unresolved", reason: "namespaced-component" };
	}
	const definition = buildDefinition(ws, resolution.declaration, head);
	if (!definition) {
		return { kind: "unresolved", reason: "not-a-function-component" };
	}
	return { kind: "local", definition };
}

/** JSX a component returns, ignoring returns that belong to inner callbacks. */
export function componentReturnExpressions(fn: ComponentFunction): Node[] {
	const body = fn.getBody();
	if (!body) {
		return [];
	}
	if (!Node.isBlock(body)) {
		return [body];
	}
	const out: Node[] = [];
	for (const statement of body.getDescendantsOfKind(
		SyntaxKind.ReturnStatement,
	)) {
		if (nearestFunction(statement) !== fn) {
			continue;
		}
		const expression = statement.getExpression();
		if (expression) {
			out.push(expression);
		}
	}
	return out;
}

function nearestFunction(node: Node): Node | undefined {
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

/** Every function component declared in the scanned files. */
export function collectComponents(
	ws: Workspace,
	files: SourceFile[],
): Record<string, ComponentInfo> {
	const out: Record<string, ComponentInfo> = {};
	for (const sourceFile of files) {
		const candidates: Array<{ node: Node; name: string }> = [];
		for (const declaration of sourceFile.getFunctions()) {
			candidates.push({
				node: declaration,
				name: declaration.getName() ?? fallbackComponentName(sourceFile),
			});
		}
		for (const declaration of sourceFile.getVariableDeclarations()) {
			if (componentFunctionOf(declaration)) {
				candidates.push({ node: declaration, name: declaration.getName() });
			}
		}
		// `export default () => …` is a declaration in neither of those lists, yet
		// the tree resolves `<Card/>` straight to it — leaving it out left the id
		// its nodes point at missing from the inventory.
		for (const assignment of sourceFile.getExportAssignments()) {
			if (assignment.isExportEquals()) {
				continue;
			}
			const expression = assignment.getExpression();
			if (componentFunctionOf(expression)) {
				candidates.push({
					node: expression,
					name: declaredNameOf(expression) ?? fallbackComponentName(sourceFile),
				});
			}
		}
		for (const candidate of candidates) {
			if (!/^[A-Z]/.test(candidate.name)) {
				continue;
			}
			const definition = buildDefinition(ws, candidate.node, candidate.name);
			if (!definition) {
				continue;
			}
			out[definition.id] = {
				id: definition.id,
				name: definition.name,
				file: definition.file,
				loc: definition.loc,
				propNames: definition.propNames,
				forwardsSpread: definition.forwardsSpread,
				exportKind: definition.exportKind,
			};
		}
	}
	return out;
}
