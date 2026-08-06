import { Node, type SourceFile, SyntaxKind } from "ts-morph";
import { dedupeDiagnostics, info } from "../diagnostics";
import type {
	Diagnostic,
	SourceLoc,
	TestIdOccurrence,
	TestIdTree,
	TestIdValue,
	UiNode,
} from "../types";
import { Budget } from "../util/budget";
import { keyFold, matchesAnyGlob, toPosix } from "../util/paths";
import { isInNodeModules, resolveExportedName } from "../util/resolve";
import type { Workspace } from "../workspace";
import {
	buildDefinition,
	type ComponentDefinition,
	collectComponents,
	componentReturnExpressions,
	resolveComponentRef,
} from "./componentGraph";
import {
	isComponentTag,
	isConditionallyRendered,
	isRepeated,
	type ScannedElement,
	scanFileElements,
	scanFileTestIds,
} from "./scanTestIds";

export interface TestIdTreeOptions {
	attribute?: string;
	/** File path (workspace-relative) whose default export is the tree root. */
	entry?: string;
	include?: string[];
	exclude?: string[];
	maxDepth?: number;
	maxNodes?: number;
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_NODES = 800;
const ENTRY_BASENAMES = ["main.tsx", "main.jsx", "index.tsx", "index.jsx"];

interface ExpandState {
	/** Prop name to the value the call site passed. */
	bindings: Map<string, TestIdValue>;
	/** Value passed for the test-id attribute itself at the call site. */
	directAttribute: TestIdValue | null;
	conditional: boolean;
	repeated: boolean;
}

const EMPTY_STATE: ExpandState = {
	bindings: new Map(),
	directAttribute: null,
	conditional: false,
	repeated: false,
};

/** Field separators that cannot occur in an identifier or in source text. */
const FIELD = "\u0000";
const ITEM = "\u0001";
const PART = "\u0002";

function valueSignature(value: TestIdValue): string {
	return [value.kind, value.value ?? "", value.prefix ?? "", value.raw].join(
		FIELD,
	);
}

/**
 * Identity of a component expansion: the component plus everything the call
 * site contributes to it.
 *
 * A component's subtree is site-independent *except* for the prop values that
 * flow into it and the conditional/repeated context it inherits — those three
 * are exactly the `ExpandState` fields the walk reads. Two sites that agree on
 * all of them produce byte-identical subtrees, so the second can reference the
 * first. Two sites that differ on any of them are expanded separately.
 *
 * JSX children are deliberately absent: the walk does not expand them (every
 * such site is marked `children-composition`), so they cannot change the
 * subtree. Whoever lifts that limitation must add them to this key.
 */
function expansionKey(componentRef: string, state: ExpandState): string {
	const bindings = [...state.bindings]
		.map(([name, value]) => `${name}=${valueSignature(value)}`)
		.sort()
		.join(ITEM);
	return [
		componentRef,
		bindings,
		state.directAttribute ? valueSignature(state.directAttribute) : "",
		state.conditional ? "conditional" : "",
		state.repeated ? "repeated" : "",
	].join(PART);
}

function selectFiles(ws: Workspace, options: TestIdTreeOptions): SourceFile[] {
	const include = options.include ?? [];
	const exclude = options.exclude ?? [];
	return ws.jsxFiles().filter((file) => {
		const rel = ws.rel(file.getFilePath());
		if (include.length > 0 && !matchesAnyGlob(rel, include)) {
			return false;
		}
		if (exclude.length > 0 && matchesAnyGlob(rel, exclude)) {
			return false;
		}
		return true;
	});
}

function findEntryComponent(
	ws: Workspace,
	files: SourceFile[],
	options: TestIdTreeOptions,
): { definition: ComponentDefinition | null; reason?: string } {
	const resolveFrom = (
		sourceFile: SourceFile,
		tag: string,
	): ComponentDefinition | null => {
		const resolution = resolveComponentRef(ws, ws.project, sourceFile, tag, {
			preferSyntacticResolution: ws.options.preferSyntacticResolution ?? true,
		});
		return resolution.kind === "local" ? resolution.definition : null;
	};

	if (options.entry) {
		const wanted = keyFold(toPosix(options.entry));
		const target = files.find((file) => {
			const rel = keyFold(ws.rel(file.getFilePath()));
			return rel === wanted || rel.endsWith(`/${wanted}`);
		});
		if (!target) {
			return {
				definition: null,
				reason: `Entry file "${options.entry}" was not found among the scanned files.`,
			};
		}
		const own = firstComponentIn(ws, target);
		if (own) {
			return { definition: own };
		}
		return {
			definition: null,
			reason: `Entry file "${options.entry}" does not declare a component.`,
		};
	}

	// `main.tsx` renders the real root; follow the first local component it uses.
	const bootstraps = files
		.filter((file) => ENTRY_BASENAMES.includes(file.getBaseName()))
		.sort((a, b) => a.getFilePath().length - b.getFilePath().length);
	for (const bootstrap of bootstraps) {
		for (const element of [
			...bootstrap.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
			...bootstrap.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
		]) {
			const tag = element.getTagNameNode().getText();
			if (!/^[A-Z]/.test(tag)) {
				continue;
			}
			const definition = resolveFrom(bootstrap, tag);
			if (definition) {
				return { definition };
			}
		}
	}

	const app = files.find((file) =>
		/(^|\/)App\.[jt]sx$/.test(file.getFilePath()),
	);
	if (app) {
		const definition = firstComponentIn(ws, app);
		if (definition) {
			return { definition };
		}
	}

	return {
		definition: null,
		reason:
			"No entry could be auto-detected (looked for main/index bootstrap files and an App component).",
	};
}

function firstComponentIn(
	ws: Workspace,
	sourceFile: SourceFile,
): ComponentDefinition | null {
	// The default export first, whether or not it has a name of its own:
	// `export default function () {}` and `export default () => …` are the only
	// component plenty of files declare, and skipping them dropped the whole tree
	// to a flat inventory that claimed the file declared nothing.
	//
	// The declaration is taken wherever the resolver found it, including another
	// file: `src/index.tsx` doing `export { default } from "./App"` is an
	// ordinary React entry point, and rejecting it because the declaration lives
	// in `App.tsx` dropped that entry to flat fidelity too. `buildDefinition`
	// keys the definition off the *declaring* file, so the root still comes back
	// as `src/App.tsx#default` — the same id `collectComponents` minted for it.
	// A declaration under `node_modules` is a boundary the scanner reports rather
	// than crosses, exactly as `resolveComponentRef` treats an imported tag.
	const defaultExport = resolveExportedName(ws.project, sourceFile, "default");
	if (
		defaultExport &&
		!isInNodeModules(defaultExport.sourceFile.getFilePath())
	) {
		const built = buildDefinition(
			ws,
			defaultExport.declaration,
			defaultExport.name,
		);
		// A named default export still has to look like a component, so a file
		// whose default export is a lowercase helper keeps falling through to the
		// component loops below. An anonymous one has no name to judge.
		if (
			built &&
			(defaultExport.name === "default" || /^[A-Z]/.test(built.name))
		) {
			return built;
		}
	}
	for (const declaration of sourceFile.getFunctions()) {
		const name = declaration.getName();
		if (name && /^[A-Z]/.test(name)) {
			return buildLocal(ws, sourceFile, name);
		}
	}
	for (const declaration of sourceFile.getVariableDeclarations()) {
		const name = declaration.getName();
		if (/^[A-Z]/.test(name)) {
			const built = buildLocal(ws, sourceFile, name);
			if (built) {
				return built;
			}
		}
	}
	return null;
}

function buildLocal(
	ws: Workspace,
	sourceFile: SourceFile,
	name: string,
): ComponentDefinition | null {
	const resolution = resolveComponentRef(ws, ws.project, sourceFile, name, {
		preferSyntacticResolution: true,
	});
	return resolution.kind === "local" ? resolution.definition : null;
}

/**
 * Builds the UI test-id tree.
 *
 * `inventory` is populated in both fidelity modes on purpose: coverage runs off
 * the inventory, not the tree, so a component that exists but is unreachable
 * from the auto-detected entry must never become "dead selector" fuel.
 */
export function buildTestIdTree(
	ws: Workspace,
	options: TestIdTreeOptions = {},
): TestIdTree {
	const startedAt = Date.now();
	const resolvedAttribute = options.attribute
		? { attribute: options.attribute, source: "param" as const }
		: ws.testIdAttribute();
	const attribute = resolvedAttribute.attribute;
	const files = selectFiles(ws, options);
	const warnings: Diagnostic[] = [];

	const inventory: TestIdOccurrence[] = [];
	const elementsByFile = new Map<string, ScannedElement[]>();
	for (const sourceFile of files) {
		const rel = ws.rel(sourceFile.getFilePath());
		elementsByFile.set(rel, scanFileElements(sourceFile, attribute, rel));
		inventory.push(...scanFileTestIds(sourceFile, attribute, rel));
	}

	const components = collectComponents(ws, files);
	const budget = new Budget(
		options.maxNodes ?? DEFAULT_MAX_NODES,
		options.maxDepth ?? DEFAULT_MAX_DEPTH,
	);
	const entry = findEntryComponent(ws, files, options);

	let roots: UiNode[] = [];
	let fidelity: TestIdTree["fidelity"] = "flat";
	let fidelityReason: string | undefined = entry.reason;

	if (entry.definition) {
		const builder = new TreeBuilder(ws, attribute, budget, warnings);
		roots = builder.expandComponent(
			entry.definition,
			0,
			new Set<string>(),
			EMPTY_STATE,
		);
		fidelity = "full";
		fidelityReason = undefined;
		mergeResolvedOccurrences(inventory, roots);
	} else if (fidelityReason) {
		warnings.push(info("entry-not-found", fidelityReason));
	}

	const dynamic = inventory.filter(
		(occurrence) => occurrence.value.kind === "dynamic",
	).length;

	const tree: TestIdTree = {
		schemaVersion: 1,
		scanner: "jsx",
		attribute,
		attributeSource: resolvedAttribute.source,
		fidelity,
		roots,
		inventory,
		components,
		warnings: dedupeDiagnostics(warnings),
		stats: {
			files: files.length,
			occurrences: inventory.length,
			dynamic,
			parseMs: Date.now() - startedAt,
		},
	};
	if (fidelityReason) {
		tree.fidelityReason = fidelityReason;
	}
	if (budget.exhausted) {
		tree.truncated = true;
	}
	return tree;
}

/**
 * Folds ids that only became knowable through one-hop prop forwarding back into
 * the flat inventory, and drops the `dynamic` placeholder they replace.
 *
 * Indistinguishable occurrences are collapsed: one source location reached from
 * two render sites that bound the same value with the same flags is one fact,
 * and collapsing it keeps the inventory identical whether or not the tree
 * de-duplicated those sites. Sites that bind *different* values at the same
 * location still contribute one occurrence each — that is exactly the set
 * coverage needs.
 */
function mergeResolvedOccurrences(
	inventory: TestIdOccurrence[],
	roots: UiNode[],
): void {
	const resolved: TestIdOccurrence[] = [];
	const resolvedLocs = new Set<string>();
	const seen = new Set<string>();

	const visit = (node: UiNode) => {
		if (node.testId && (node.viaProp || node.viaSpread)) {
			const key = `${node.loc.file}:${node.loc.line}:${node.loc.column ?? 0}`;
			resolvedLocs.add(key);
			const occurrence: TestIdOccurrence = {
				value: node.testId,
				file: node.file,
				loc: node.loc,
				tag: node.tag,
				component: node.component,
			};
			if (node.conditional) {
				occurrence.conditional = true;
			}
			if (node.repeated) {
				occurrence.repeated = true;
			}
			if (node.viaProp) {
				occurrence.viaProp = node.viaProp;
			}
			// One hop of forwarding proven, but the id landed on another component
			// rather than on a host element: still a prop, still unproven.
			if (node.nodeType === "component") {
				occurrence.unforwarded = true;
			}
			const identity = [
				key,
				valueSignature(node.testId),
				occurrence.conditional ? "conditional" : "",
				occurrence.repeated ? "repeated" : "",
				occurrence.viaProp ?? "",
			].join(PART);
			if (!seen.has(identity)) {
				seen.add(identity);
				resolved.push(occurrence);
			}
		}
		for (const child of node.children) {
			visit(child);
		}
	};
	for (const root of roots) {
		visit(root);
	}
	if (resolved.length === 0) {
		return;
	}

	for (let index = inventory.length - 1; index >= 0; index -= 1) {
		const occurrence = inventory[index];
		if (occurrence.value.kind !== "dynamic") {
			continue;
		}
		const key = `${occurrence.loc.file}:${occurrence.loc.line}:${occurrence.loc.column ?? 0}`;
		if (resolvedLocs.has(key)) {
			inventory.splice(index, 1);
		}
	}
	inventory.push(...resolved);
}

class TreeBuilder {
	/** Per-file element index, keyed by node start offset. */
	private readonly scanCache = new Map<string, Map<number, ScannedElement>>();

	/**
	 * Expansion key to the render site that already expanded it in full.
	 *
	 * Only *self-contained* expansions are recorded — see {@link boundaries}.
	 */
	private readonly expansions = new Map<string, SourceLoc>();

	/**
	 * Count of places the walk stopped early for a reason that depends on where
	 * it was, rather than on what it was expanding: the recursion guard, the
	 * depth limit and the node budget.
	 *
	 * An expansion that bumped this counter is only valid at the site that
	 * produced it — a different site has a different ancestor path, a different
	 * depth and a different amount of budget left — so it is never memoized.
	 */
	private boundaries = 0;

	constructor(
		private readonly ws: Workspace,
		private readonly attribute: string,
		private readonly budget: Budget,
		private readonly warnings: Diagnostic[],
	) {}

	private scannedAt(
		owner: ComponentDefinition,
		start: number,
	): ScannedElement | undefined {
		const path = owner.sourceFile.getFilePath();
		let index = this.scanCache.get(path);
		if (!index) {
			index = new Map<number, ScannedElement>();
			for (const element of scanFileElements(
				owner.sourceFile,
				this.attribute,
				owner.file,
			)) {
				index.set(element.node.getStart(), element);
			}
			this.scanCache.set(path, index);
		}
		return index.get(start);
	}

	expandComponent(
		definition: ComponentDefinition,
		depth: number,
		path: Set<string>,
		state: ExpandState,
	): UiNode[] {
		if (path.has(definition.id)) {
			this.boundaries += 1;
			return [];
		}
		const nextPath = new Set(path);
		nextPath.add(definition.id);

		const returns = componentReturnExpressions(definition.fn);
		if (returns.length === 0) {
			return [];
		}
		if (returns.length === 1) {
			return this.walk(returns[0], definition, depth, nextPath, state);
		}
		// Several `return` statements: each is a mutually exclusive branch.
		return returns.map((expression) => {
			const position = definition.sourceFile.getLineAndColumnAtPos(
				expression.getStart(),
			);
			return {
				tag: "#branch",
				nodeType: "branch" as const,
				file: definition.file,
				loc: {
					file: definition.file,
					line: position.line,
					column: position.column,
				},
				component: definition.name,
				conditional: true,
				children: this.walk(expression, definition, depth, nextPath, {
					...state,
					conditional: true,
				}),
			};
		});
	}

	private walk(
		node: Node,
		owner: ComponentDefinition,
		depth: number,
		path: Set<string>,
		state: ExpandState,
	): UiNode[] {
		if (Node.isParenthesizedExpression(node)) {
			return this.walk(node.getExpression(), owner, depth, path, state);
		}
		if (Node.isJsxExpression(node)) {
			const expression = node.getExpression();
			return expression ? this.walk(expression, owner, depth, path, state) : [];
		}
		if (Node.isJsxFragment(node)) {
			return this.walkChildren(
				node.getJsxChildren(),
				owner,
				depth,
				path,
				state,
			);
		}
		if (Node.isJsxElement(node)) {
			return this.element(
				node.getOpeningElement(),
				node.getJsxChildren(),
				owner,
				depth,
				path,
				state,
			);
		}
		if (Node.isJsxSelfClosingElement(node)) {
			return this.element(node, [], owner, depth, path, state);
		}
		if (Node.isConditionalExpression(node)) {
			return [
				...this.walk(node.getWhenTrue(), owner, depth, path, {
					...state,
					conditional: true,
				}),
				...this.walk(node.getWhenFalse(), owner, depth, path, {
					...state,
					conditional: true,
				}),
			];
		}
		if (Node.isBinaryExpression(node)) {
			const operator = node.getOperatorToken().getKind();
			if (
				operator === SyntaxKind.AmpersandAmpersandToken ||
				operator === SyntaxKind.BarBarToken ||
				operator === SyntaxKind.QuestionQuestionToken
			) {
				return this.walk(node.getRight(), owner, depth, path, {
					...state,
					conditional: true,
				});
			}
			return [];
		}
		if (Node.isArrayLiteralExpression(node)) {
			return node
				.getElements()
				.flatMap((element) => this.walk(element, owner, depth, path, state));
		}
		if (Node.isCallExpression(node)) {
			const callee = node.getExpression();
			const isMap =
				Node.isPropertyAccessExpression(callee) &&
				(callee.getName() === "map" || callee.getName() === "flatMap");
			if (!isMap) {
				return [];
			}
			const callback = node.getArguments()[0];
			if (!callback) {
				return [];
			}
			return this.walk(callback, owner, depth, path, {
				...state,
				repeated: true,
			});
		}
		if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
			const body = node.getBody();
			if (Node.isBlock(body)) {
				return body
					.getDescendantsOfKind(SyntaxKind.ReturnStatement)
					.flatMap((statement) => {
						const expression = statement.getExpression();
						return expression
							? this.walk(expression, owner, depth, path, state)
							: [];
					});
			}
			return this.walk(body, owner, depth, path, state);
		}
		return [];
	}

	private walkChildren(
		children: Node[],
		owner: ComponentDefinition,
		depth: number,
		path: Set<string>,
		state: ExpandState,
	): UiNode[] {
		return children.flatMap((child) =>
			this.walk(child, owner, depth, path, state),
		);
	}

	private element(
		opening: Node,
		children: Node[],
		owner: ComponentDefinition,
		depth: number,
		path: Set<string>,
		state: ExpandState,
	): UiNode[] {
		if (
			!Node.isJsxOpeningElement(opening) &&
			!Node.isJsxSelfClosingElement(opening)
		) {
			return [];
		}
		if (!this.budget.spend()) {
			this.boundaries += 1;
			return [];
		}

		const scanned = this.scannedAt(owner, opening.getStart());
		const tag = opening.getTagNameNode().getText();
		const position = owner.sourceFile.getLineAndColumnAtPos(opening.getStart());
		const node: UiNode = {
			tag,
			// Same predicate the scan uses, so an id's `unforwarded` flag and the
			// node it hangs off can never disagree about what the tag is.
			nodeType: isComponentTag(tag) ? "component" : "element",
			file: owner.file,
			loc: {
				file: owner.file,
				line: position.line,
				column: position.column,
			},
			component: owner.name,
			children: [],
		};
		const conditional =
			state.conditional ||
			isConditionallyRendered(opening) ||
			!!scanned?.conditional;
		const repeated = state.repeated || isRepeated(opening);
		if (conditional) {
			node.conditional = true;
		}
		if (repeated) {
			node.repeated = true;
		}

		this.bindTestId(node, scanned, state);

		if (node.nodeType === "element") {
			node.children = this.walkChildren(children, owner, depth, path, state);
			return [node];
		}

		// Component: recurse into its definition with the call-site props.
		const resolution = resolveComponentRef(
			this.ws,
			this.ws.project,
			owner.sourceFile,
			tag,
			{ preferSyntacticResolution: true },
		);
		if (resolution.kind === "external") {
			node.unresolved = { reason: "external-module" };
			return [node];
		}
		if (resolution.kind === "unresolved") {
			node.unresolved = { reason: resolution.reason };
			return [node];
		}
		node.componentRef = resolution.definition.id;
		// Recursion on the current path stays a `repeated` leaf: this is the
		// component rendering itself, not a second independent render site.
		if (path.has(resolution.definition.id)) {
			this.boundaries += 1;
			node.repeated = true;
			return [node];
		}

		// Children passed through JSX composition are out of scope for v1.
		if (children.length > 0) {
			node.unresolved = { reason: "children-composition" };
		}

		const childState: ExpandState = {
			bindings: this.callSiteBindings(scanned, resolution.definition),
			directAttribute: scanned?.testIds[0] ?? null,
			conditional,
			repeated,
		};
		const key = expansionKey(resolution.definition.id, childState);

		// Second and later sites of an identical expansion become references.
		// This is checked *before* the depth limit on purpose: emitting a
		// reference expands nothing, so it consumes no depth and no nodes beyond
		// the one already spent on this element. The referenced expansion is
		// known to be complete, so pointing a deep site at it reports strictly
		// more than the `depth-limit-reached` stub it replaces.
		const expandedAt = this.expansions.get(key);
		if (expandedAt) {
			node.expandedAt = expandedAt;
			return [node];
		}

		if (!this.budget.allowsDepth(depth + 1)) {
			this.boundaries += 1;
			node.unresolved = { reason: "depth-limit-reached" };
			this.warnings.push(
				info(
					"depth-limit-reached",
					`Depth limit reached at <${tag}>; its subtree was not expanded.`,
					node.loc,
				),
			);
			return [node];
		}

		const boundariesBefore = this.boundaries;
		node.children = this.expandComponent(
			resolution.definition,
			depth + 1,
			path,
			childState,
		);
		if (this.boundaries === boundariesBefore && node.children.length > 0) {
			this.expansions.set(key, node.loc);
		}
		return [node];
	}

	/**
	 * Call-site attribute values, keyed by the name the callee's *body* uses.
	 *
	 * `<Card testId="x" />` reaching `function Card({ testId: id })` has to bind
	 * under `id`, or the `data-testid={id}` inside would be reported dynamic even
	 * though its value is right there at the call site.
	 */
	private callSiteBindings(
		scanned: ScannedElement | undefined,
		definition: ComponentDefinition,
	): Map<string, TestIdValue> {
		const bindings = new Map<string, TestIdValue>();
		if (!scanned) {
			return bindings;
		}
		for (const [name, values] of scanned.attributes) {
			const [first] = values;
			if (first && first.kind !== "dynamic") {
				bindings.set(name, first);
			}
		}
		for (const [local, propName] of definition.propAliases) {
			const value = bindings.get(propName);
			if (value) {
				bindings.set(local, value);
			}
		}
		return bindings;
	}

	/**
	 * Resolves the element's test id, applying the two supported one-hop
	 * forwarding shapes. Everything else is reported as `unresolved` rather than
	 * guessed: an agent trusting a silently-wrong tree is worse off than one
	 * told where the analysis stops.
	 */
	private bindTestId(
		node: UiNode,
		scanned: ScannedElement | undefined,
		state: ExpandState,
	): void {
		if (!scanned) {
			return;
		}
		const [value] = scanned.testIds;
		if (value && value.kind !== "dynamic") {
			node.testId = value;
			return;
		}
		if (value && value.kind === "dynamic") {
			const propName = propNameFromExpression(value.raw);
			const bound = propName ? state.bindings.get(propName) : undefined;
			if (propName && bound) {
				node.testId = bound;
				node.viaProp = propName;
				return;
			}
			node.testId = value;
			return;
		}
		if (scanned.hasSpread) {
			if (state.directAttribute) {
				node.testId = state.directAttribute;
				node.viaSpread = true;
				return;
			}
			node.unresolved = { reason: "spread-props" };
		}
	}
}

/** `testId` and `props.testId` both bind; anything else is out of scope for v1. */
function propNameFromExpression(raw: string): string | null {
	const trimmed = raw.trim();
	if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
		return trimmed;
	}
	const member = /^props\.([A-Za-z_$][\w$]*)$/.exec(trimmed);
	return member ? member[1] : null;
}
