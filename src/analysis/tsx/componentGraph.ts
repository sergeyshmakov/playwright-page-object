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
import { hasDefaultKeyword, isDefaultExported } from "../util/exports";
import { defKey } from "../util/paths";
import { lineAndColumnAt } from "../util/position";
import {
	isRelativeSpecifier,
	type RefResolution,
	type ResolveOptions,
	resolveIdentifier,
	resolveModuleSpecifier,
} from "../util/resolve";
import { isWorkspaceLocal } from "../util/workspaceRoot";
import type { Workspace } from "../workspace";
import {
	fallbackComponentName,
	readExpressionValue,
	type ScannedElement,
} from "./scanTestIds";

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
	 * Local binding name to the default it declares (`{ testId = "Row" }`).
	 *
	 * The map answers "what renders when the call site passes nothing", and the
	 * answer has three shapes, all of which have to be told apart. One statically
	 * known value is recorded as it is. A default nobody can read
	 * (`{ testId = makeId() }`) or one that is itself a choice
	 * (`{ testId = cond ? "A" : "B" }`) is recorded as a `dynamic` marker: an id
	 * *does* render, it just cannot be named here. A name that is absent declares
	 * no default at all, and only then does the attribute provably render nothing.
	 * Leaving the unreadable ones out collapsed the middle case onto the last one
	 * and reported `testIdAbsent` for an element that renders an id.
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
		(Node.isFunctionDeclaration(declaration) && hasDefaultKeyword(declaration))
	) {
		return fallbackComponentName(declaration.getSourceFile());
	}
	return null;
}

function exportKindOf(node: Node, name: string): "default" | "named" {
	if (Node.isFunctionDeclaration(node) && hasDefaultKeyword(node)) {
		return "default";
	}
	if (isDefaultExportExpression(node)) {
		return "default";
	}
	// `export default <Identifier>` and `export { X as default }`, both read off
	// the source. The old tail of this function re-asked the same question of the
	// file's variable declaration through `isDefaultExport()`, whose keyword check
	// can never fire on a `VariableDeclaration` — so every named component paid for
	// a type checker to be told what the loop above had already established.
	const sourceFile = node.getSourceFile();
	for (const assignment of sourceFile.getExportAssignments()) {
		const expression = assignment.getExpression();
		if (Node.isIdentifier(expression) && expression.getText() === name) {
			return "default";
		}
	}
	return isDefaultExported(node) ? "default" : "named";
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
	const position = lineAndColumnAt(sourceFile, declaration.getStart());
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

/** Local binding name to module specifier, for non-relative imports only. */
function nonRelativeImportBindings(
	sourceFile: SourceFile,
): Map<string, string> {
	const bindings = new Map<string, string>();
	for (const declaration of sourceFile.getImportDeclarations()) {
		const specifier = declaration.getModuleSpecifierValue();
		if (isRelativeSpecifier(specifier)) {
			continue;
		}
		const defaultImport = declaration.getDefaultImport();
		if (defaultImport) {
			bindings.set(defaultImport.getText(), specifier);
		}
		const namespaceImport = declaration.getNamespaceImport();
		if (namespaceImport) {
			bindings.set(namespaceImport.getText(), specifier);
		}
		for (const named of declaration.getNamedImports()) {
			const local = named.getAliasNode() ?? named.getNameNode();
			bindings.set(local.getText(), specifier);
		}
	}
	return bindings;
}

/** Evidence that the scanned sources are not the whole UI. */
export interface ExternalModuleEvidence {
	/** Sorted, capped list of specifiers supplying component tags. */
	modules: string[];
	/** Component tags whose head resolved to one of those modules. */
	tags: number;
}

const MAX_EXTERNAL_MODULES = 10;

/** Workspace memo slot holding the shared "outside the workspace" answers. */
const CENSUS_CACHE_KEY = "external-module-census";

/** Separator that cannot occur in a path or in a module specifier. */
const CACHE_FIELD = "\u0000";

/**
 * Counts component tags rendered from modules outside the scanned sources.
 *
 * This is how the report tells "no page object selects this id" apart from
 * "the element rendering it is in a package nobody put in scope". In a monorepo
 * pointed at one app, whole design systems and sibling feature packages live
 * behind bare specifiers, their test ids are invisible, and every selector for
 * them looks dead. The count is not a diagnosis — a genuinely external `react`
 * import contributes nothing because `<div>` is not a component tag — but it is
 * the difference between a report that is wrong and one that says it might be.
 *
 * Non-relative specifiers only: a relative import is by construction a file the
 * scan either saw or deliberately scoped out, and `inventory-scope-gap` already
 * covers the latter.
 */
export class ExternalModuleCensus {
	private readonly modules = new Set<string>();
	/**
	 * Importing file plus specifier to "resolves outside the workspace", resolved
	 * at most once.
	 *
	 * The specifier alone is not the question being asked. `resolveModuleSpecifier`
	 * walks up from the *importing* file looking for `node_modules/<pkg>`, so in a
	 * monorepo where one package links `@acme/ui` to its own sources and another
	 * has an installed copy, one specifier has two answers and whichever file was
	 * scanned first decided for every other.
	 *
	 * Held on the workspace rather than on the census. A census is built per tree,
	 * and a session builds several — the scan-wide one, the entry-scoped one, the
	 * one coverage asks for — each of which was re-resolving every bare specifier
	 * in the repository from scratch. The answers are a property of the files, not
	 * of the tree being built, so they belong to the epoch: `Workspace.memo`
	 * hands the same map to every census until something invalidates it, and hands
	 * out a fresh one the moment anything does.
	 */
	private readonly outside: Map<string, boolean>;
	private tagCount = 0;

	constructor(private readonly ws: Workspace) {
		this.outside = ws.memo(
			CENSUS_CACHE_KEY,
			[],
			() => new Map<string, boolean>(),
		);
	}

	add(sourceFile: SourceFile, elements: ScannedElement[]): void {
		let bindings: Map<string, string> | undefined;
		for (const element of elements) {
			if (element.nodeType !== "component") {
				continue;
			}
			// Deferred: a file with no component tags never pays for the import walk.
			bindings ??= nonRelativeImportBindings(sourceFile);
			if (bindings.size === 0) {
				return;
			}
			const specifier = bindings.get(element.tag.split(".")[0]);
			if (specifier === undefined || !this.isOutside(sourceFile, specifier)) {
				continue;
			}
			this.tagCount += 1;
			this.modules.add(specifier);
		}
	}

	evidence(): ExternalModuleEvidence {
		return {
			modules: [...this.modules].sort().slice(0, MAX_EXTERNAL_MODULES),
			tags: this.tagCount,
		};
	}

	private isOutside(fromFile: SourceFile, specifier: string): boolean {
		const key = `${fromFile.getFilePath()}${CACHE_FIELD}${specifier}`;
		const cached = this.outside.get(key);
		if (cached !== undefined) {
			return cached;
		}
		let outside: boolean;
		try {
			const resolved = resolveModuleSpecifier(
				this.ws.project,
				fromFile,
				specifier,
			);
			outside =
				resolved === undefined ||
				!isWorkspaceLocal(this.ws.project, resolved.getFilePath());
		} catch {
			outside = true;
		}
		this.outside.set(key, outside);
		return outside;
	}
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
