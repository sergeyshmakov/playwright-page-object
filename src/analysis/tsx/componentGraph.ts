import {
	type ArrowFunction,
	type FunctionDeclaration,
	type FunctionExpression,
	Node,
	type Project,
	type SourceFile,
	SyntaxKind,
} from "ts-morph";
import type { ComponentInfo, SourceLoc } from "../types";
import { defKey } from "../util/paths";
import {
	isInNodeModules,
	type RefResolution,
	type ResolveOptions,
	resolveIdentifier,
} from "../util/resolve";
import type { Workspace } from "../workspace";

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
	/** `rest` in `({ a, ...rest })`, or the whole parameter name (`props`). */
	spreadSourceNames: string[];
	forwardsSpread: boolean;
	exportKind: "default" | "named";
}

export type ComponentResolution =
	| { kind: "local"; definition: ComponentDefinition }
	| { kind: "external"; module: string }
	| { kind: "unresolved"; reason: string };

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

interface PropsRead {
	propNames: string[];
	spreadSourceNames: string[];
	propAliases: Map<string, string>;
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
		for (const element of nameNode.getElements()) {
			const local = element.getName();
			if (element.getDotDotDotToken()) {
				spreadSourceNames.push(local);
				continue;
			}
			const propName = element.getPropertyNameNode()?.getText() ?? local;
			propNames.push(propName);
			if (propName !== local) {
				propAliases.set(local, propName);
			}
		}
		return { propNames, spreadSourceNames, propAliases };
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

function exportKindOf(node: Node, name: string): "default" | "named" {
	if (Node.isFunctionDeclaration(node) && node.isDefaultExport()) {
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

function buildDefinition(
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
	const { propNames, spreadSourceNames, propAliases } = readProps(fn);
	// Prefer the declared name over the local alias at the import site, so
	// `import CartItemComponent from "./CartItem"` still reports `CartItem`.
	const declaredName =
		(Node.isFunctionDeclaration(declaration) ||
		Node.isVariableDeclaration(declaration)
			? declaration.getName()
			: undefined) ?? name;
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
		spreadSourceNames,
		forwardsSpread: forwardsSpread(fn, spreadSourceNames),
		exportKind,
	};
}

/**
 * Resolves a JSX tag to its component definition.
 *
 * Same syntax-first strategy as the page-object resolver, and definitions under
 * `node_modules` are rejected outright: a `<Button>` from a design system is a
 * boundary the scanner reports rather than crosses.
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
	if (isInNodeModules(resolution.sourceFile.getFilePath())) {
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
			const name = declaration.getName();
			candidates.push({
				node: declaration,
				name: name ?? sourceFile.getBaseName().replace(/\.[jt]sx?$/, ""),
			});
		}
		for (const declaration of sourceFile.getVariableDeclarations()) {
			if (componentFunctionOf(declaration)) {
				candidates.push({ node: declaration, name: declaration.getName() });
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
