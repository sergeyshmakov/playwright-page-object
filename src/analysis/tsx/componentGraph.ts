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
	/**
	 * How many distinct specifiers there really are.
	 *
	 * Separate from `modules.length` because that is the length of a *display
	 * sample*. Reporting the sample's length as the count made the warning say
	 * "10 module(s)" on every repository with ten or more — saturating silently,
	 * so a reader sizing their blind spot on a 44-module app underestimated it
	 * more than four-fold. A capped list is fine; a capped number is a false
	 * statement.
	 */
	moduleCount: number;
	/**
	 * The subset of `modules` whose sources were found inside this repository,
	 * reached through a `node_modules` link — sorted and capped like `modules`.
	 *
	 * `sourceRoot` is computed from exactly these, so only these can be said to
	 * have sources here. The remedy sentence used to be written about every
	 * named module, which claimed an in-repo source for `@sentry/react`.
	 */
	linkedModules: string[];
	/** How many specifiers are linked, for the same reason as `moduleCount`. */
	linkedCount: number;
	/** Component tags whose head resolved to one of those modules. */
	tags: number;
	/**
	 * Where to root an analysis that would see those modules' sources, or `null`
	 * when none of them has sources to see.
	 *
	 * Non-null exactly when at least one specifier resolves through a
	 * `node_modules` link onto ordinary source outside the analysed root — the
	 * workspace-monorepo shape, where the sources are right there and the root is
	 * simply one package too deep. It is the deepest directory containing both
	 * the current root and those sources, which makes it the value to re-root at.
	 *
	 * `null` means the tags come from installed packages or from specifiers that
	 * do not resolve at all, and no scope change reaches them. The distinction is
	 * the whole point: advice to widen the scan is unfollowable in the first case
	 * (a scope outside the root contributes nothing) and impossible in the second.
	 */
	sourceRoot: string | null;
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
	private readonly outside: Map<string, ModulePlacement>;
	/** Real paths of external modules whose sources sit outside the root. */
	private readonly sourcePaths = new Set<string>();
	/** Specifiers behind those paths, so the remedy can name only them. */
	private readonly linked = new Set<string>();
	/**
	 * Every importing directory per specifier that resolved to no source.
	 *
	 * A set, not one directory. `packageSourceOutsideRoot` walks up from the
	 * *importer*, so in a monorepo where one package links `@acme/ui` to its own
	 * sources and another has an installed copy, the answer depends on which
	 * importer asks - the same reason {@link placementOf} keys on the file. One
	 * sample meant whichever file was scanned first decided for the whole
	 * repository, and a specifier could be reported as linked while the sources
	 * named beside it belong to a package nothing in that scope imports.
	 *
	 * Uncapped, because the numbers derived from it have to be true. See
	 * {@link add}.
	 */
	private readonly sampleDirs = new Map<string, Set<string>>();
	private tagCount = 0;

	constructor(private readonly ws: Workspace) {
		this.outside = ws.memo(
			CENSUS_CACHE_KEY,
			[],
			() => new Map<string, ModulePlacement>(),
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
			if (specifier === undefined) {
				continue;
			}
			const placement = this.placementOf(sourceFile, specifier);
			if (!placement.outside) {
				continue;
			}
			this.tagCount += 1;
			this.modules.add(specifier);
			if (placement.sourcePath) {
				this.sourcePaths.add(placement.sourcePath);
				this.linked.add(specifier);
			} else {
				// Every distinct importing directory, not a sample. `linkedCount` and
				// `sourceRoot` are computed from what these probes find, and a capped
				// probe makes both of them lie - the count low, and the remedy's
				// common ancestor narrower than the sources it has to cover. "A
				// capped list is fine; a capped number is a false statement" applies
				// to this module's own output as much as to anything it reports.
				//
				// Directories, not files, so the set is a fraction of the repository
				// (1,621 for 4,924 files on the app this was measured against). Each
				// probe is memoized per (directory, package) and the `node_modules`
				// presence check per directory, so importers under a shared ancestor
				// cost map lookups rather than syscalls.
				let dirs = this.sampleDirs.get(specifier);
				if (!dirs) {
					dirs = new Set<string>();
					this.sampleDirs.set(specifier, dirs);
				}
				dirs.add(sourceFile.getDirectoryPath());
			}
		}
	}

	evidence(): ExternalModuleEvidence {
		const sources = new Set(this.sourcePaths);
		const linked = new Set(this.linked);
		// Deferred to here on purpose. This is the only filesystem walk the census
		// does, and doing it per (file, specifier) in `add` would run it thousands
		// of times on a monorepo; the answer it produces is one directory name for
		// one warning, so it is asked once per specifier that ended up external and
		// has no source yet — at most `MAX_EXTERNAL_MODULES` questions per tree,
		// memoized per epoch alongside the placements.
		for (const [specifier, directories] of this.sampleDirs) {
			const split = splitPackageName(specifier);
			if (!split) {
				continue;
			}
			for (const directory of directories) {
				// The importing directory is part of the key, not just the package
				// name. Without it one directory's answer was handed to every other
				// importer of the same package - so a specifier could be named as
				// linked on the strength of a probe from somewhere else entirely, and
				// `sourceRoot` widened to sources that scope never imports.
				const key = `${CACHE_FIELD}${DIAGNOSTIC_PREFIX}${CACHE_FIELD}${directory}${CACHE_FIELD}${split}`;
				let placement = this.outside.get(key);
				if (placement === undefined) {
					placement = {
						outside: true,
						sourcePath: packageSourceOutsideRoot(
							this.ws.project,
							directory,
							split,
						),
					};
					this.outside.set(key, placement);
				}
				if (placement.sourcePath) {
					sources.add(placement.sourcePath);
					linked.add(specifier);
				}
			}
		}
		return {
			modules: [...this.modules].sort().slice(0, MAX_EXTERNAL_MODULES),
			moduleCount: this.modules.size,
			linkedModules: [...linked].sort().slice(0, MAX_EXTERNAL_MODULES),
			linkedCount: linked.size,
			tags: this.tagCount,
			sourceRoot:
				sources.size === 0
					? null
					: commonAncestorDirectory([this.ws.root, ...sources]),
		};
	}

	private placementOf(
		fromFile: SourceFile,
		specifier: string,
	): ModulePlacement {
		const key = `${fromFile.getFilePath()}${CACHE_FIELD}${specifier}`;
		const cached = this.outside.get(key);
		if (cached !== undefined) {
			return cached;
		}
		let placement: ModulePlacement;
		try {
			const resolved = resolveModuleSpecifier(
				this.ws.project,
				fromFile,
				specifier,
			);
			if (resolved === undefined) {
				placement = OUTSIDE_UNRESOLVED;
			} else {
				const filePath = resolved.getFilePath();
				placement = isWorkspaceLocal(this.ws.project, filePath)
					? INSIDE
					: {
							outside: true,
							// Only a `node_modules` link onto source outside the root has a
							// directory worth naming; an installed package has none.
							sourcePath: linkedOutsideRoot(this.ws.project, filePath),
						};
			}
		} catch {
			placement = OUTSIDE_UNRESOLVED;
		}
		this.outside.set(key, placement);
		return placement;
	}
}

/** Where one specifier resolved, relative to the analysed workspace. */
interface ModulePlacement {
	outside: boolean;
	/** Real path of its source, when it is source this analysis could have read. */
	sourcePath: string | null;
}

const INSIDE: ModulePlacement = { outside: false, sourcePath: null };
const OUTSIDE_UNRESOLVED: ModulePlacement = { outside: true, sourcePath: null };

/** Cache-key namespace for the "where does this package really live" probe. */
const DIAGNOSTIC_PREFIX = "diagnostic";

/**
 * Package name of a bare specifier: `@scope/pkg` or `pkg`, subpath dropped.
 *
 * `null` for a relative or absolute specifier, which names no package and has
 * no `node_modules` directory to look for.
 */
function splitPackageName(specifier: string): string | null {
	if (specifier.startsWith(".") || specifier.startsWith("/")) {
		return null;
	}
	const segments = specifier.split("/");
	const spanned = segments[0].startsWith("@") ? 2 : 1;
	return segments.length < spanned
		? null
		: segments.slice(0, spanned).join("/");
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
