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
import { unwrapTransparent, unwrapTransparentParent } from "../util/ast";
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
import {
	commonAncestorDirectory,
	isWorkspaceLocal,
	linkedOutsideRoot,
	packageSourceOutsideRoot,
} from "../util/workspaceRoot";
import type { Workspace } from "../workspace";
import { forwardsSpread, readProps } from "./componentProps";
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

/**
 * Calls that wrap a component and return one.
 *
 * Matched by name rather than by resolving the callee. The name *is* the
 * convention here — `React.memo` and a bare `memo` are the same thing, and no
 * codebase names an unrelated function `forwardRef` and wraps a component in
 * it — while resolving would turn every call in the declaration position into a
 * module lookup.
 */
const COMPONENT_WRAPPERS = new Set(["memo", "forwardRef"]);

/**
 * The function inside any stack of component wrappers.
 *
 * `memo(Foo)`, `forwardRef(Foo)` and `memo(forwardRef(Foo))` are how a large
 * share of real React components are declared, and every one of them used to
 * resolve as `not-a-function-component` — honestly marked, so the tree never
 * lied about it, but a boundary the walk had no reason to stop at. Of the
 * defects on this branch it has the widest reach: it applies to every React
 * repository, not to a particular shape of one.
 *
 * `forwardRef`'s callback takes `(props, ref)`, and `readProps` reads the first
 * parameter, so the props side needs nothing special.
 */
function unwrapComponentWrapper(node: Node): Node {
	let current = unwrapTransparent(node);
	// Terminates: every iteration descends into a strictly smaller subexpression.
	while (Node.isCallExpression(current)) {
		const callee = current.getExpression();
		const name = Node.isPropertyAccessExpression(callee)
			? callee.getName()
			: Node.isIdentifier(callee)
				? callee.getText()
				: null;
		if (name === null || !COMPONENT_WRAPPERS.has(name)) {
			return current;
		}
		const [first] = current.getArguments();
		if (!first) {
			return current;
		}
		current = unwrapTransparent(first);
	}
	return current;
}

function asComponentFunction(node: Node): ComponentFunction | null {
	return Node.isFunctionDeclaration(node) ||
		Node.isArrowFunction(node) ||
		Node.isFunctionExpression(node)
		? node
		: null;
}

/**
 * The same-file function an identifier names.
 *
 * `memo(Foo)` is as ordinary as `memo(() => …)`, and unwrapping the call only
 * to find an identifier left it resolving as `not-a-function-component` — the
 * exact gap the unwrap was added to close, for the spelling that names its
 * component instead of inlining it. Same file only: crossing a module boundary
 * here would attribute the definition to the wrong file, which
 * `resolveComponentRef` exists to do properly.
 */
function sameFileFunction(identifier: Node): Node | null {
	// Module scope on both sides. The scan below reads the file's top-level
	// declarations, which is the right answer only when the identifier itself is
	// at top level: `memo(Inner)` written inside a function whose parameter or
	// local is also called `Inner` binds to that one, and handing back the
	// module-level function would attribute another component's test ids to this
	// site. Refusing is the safe half - the site then reports
	// `not-a-function-component`, which is what it did before this hop existed.
	for (let up = identifier.getParent(); up; up = up.getParent()) {
		if (
			Node.isFunctionDeclaration(up) ||
			Node.isFunctionExpression(up) ||
			Node.isArrowFunction(up) ||
			Node.isMethodDeclaration(up)
		) {
			return null;
		}
	}
	const name = identifier.getText();
	const sourceFile = identifier.getSourceFile();
	for (const declaration of sourceFile.getFunctions()) {
		if (declaration.getName() === name) {
			return declaration;
		}
	}
	for (const declaration of sourceFile.getVariableDeclarations()) {
		if (declaration.getName() === name) {
			return declaration.getInitializer() ?? null;
		}
	}
	return null;
}

function componentFunctionOf(node: Node): ComponentFunction | null {
	const unwrapped = unwrapComponentWrapper(node);
	const direct = asComponentFunction(unwrapped);
	if (direct) {
		return direct;
	}
	// One hop, and only when the wrapper actually peeled something off: an
	// identifier that *is* the declaration under inspection would otherwise
	// resolve to itself.
	if (Node.isIdentifier(unwrapped) && unwrapped !== node) {
		const target = sameFileFunction(unwrapped);
		if (target) {
			const resolved = asComponentFunction(unwrapComponentWrapper(target));
			if (resolved) {
				return resolved;
			}
		}
	}
	if (Node.isVariableDeclaration(node)) {
		const initializer = node.getInitializer();
		return initializer ? componentFunctionOf(initializer) : null;
	}
	return null;
}

/**
 * `export default () => …`, `export default function () {}`, `export default
 * class {}`.
 *
 * Wrappers are climbed on the way up: `export default (Card)`,
 * `export default Card as FC` and the `satisfies` spelling all put a node
 * between the expression and the assignment, and testing the immediate parent
 * read every one of them as not exported at all.
 */
function isDefaultExportExpression(node: Node): boolean {
	const clause = unwrapTransparentParent(node);
	return (
		clause !== undefined &&
		Node.isExportAssignment(clause) &&
		!clause.isExportEquals()
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

// The external-module census lives next door, and reaches callers through
// here so `tree.ts` and the barrel keep one import path.
export {
	ExternalModuleCensus,
	type ExternalModuleEvidence,
} from "./externalModules";
