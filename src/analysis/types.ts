/**
 * Wire types for the static-analysis engine.
 *
 * Everything in this file is a plain JSON-serializable shape: no `ts-morph`
 * imports, no runtime values. The MCP layer (and any future CLI `doctor`
 * command) consumes these directly.
 *
 * Regular expressions are encoded as {@link RegexValue} objects rather than
 * `RegExp` instances, because every payload has to survive `JSON.stringify`.
 */

/** A position inside a project file. `file` is posix and relative to the workspace root. */
export interface SourceLoc {
	file: string;
	line: number;
	column?: number;
}

export type DiagnosticSeverity = "error" | "warning" | "info";

/**
 * Stable identifiers for every non-fatal problem the engine can report.
 * These are part of the wire contract: renaming one is a breaking change.
 */
export type DiagnosticCode =
	// workspace / config
	| "no-tsconfig"
	| "tsconfig-not-found"
	| "playwright-config-not-found"
	| "playwright-config-ambiguous"
	| "config-shape-unrecognized"
	| "config-merge-unresolved"
	| "testid-attribute-unresolved"
	| "testdir-unresolved"
	| "testid-attribute-maybe-spread"
	| "testid-attribute-project-override"
	| "testid-attribute-inherited"
	| "testid-attribute-conflict"
	// environment sanity
	| "attribute-mismatch"
	| "attribute-no-evidence"
	| "scope-empty"
	| "scope-dir-missing"
	// page objects
	| "dynamic-selector-arg"
	| "unresolved-factory-identifier"
	| "type-annotation-mismatch"
	| "decorator-on-non-accessor"
	| "root-decorator-on-page-object"
	| "page-object-passed-as-factory"
	| "missing-host-context"
	| "unresolved-class-reference"
	| "fixtures-argument-dynamic"
	| "fixture-entry-dynamic"
	| "fixture-name-ambiguous"
	// budgets
	| "depth-limit-reached"
	| "node-budget-reached"
	// tsx
	| "entry-not-found"
	| "component-unresolved"
	| "external-component"
	| "spread-props"
	| "prop-forwarding-unsupported"
	/** One summary per tree whose walk left a structural hole. */
	| "tree-partial"
	/** `followComponents: false` stopped the walk at every component tag. */
	| "components-not-followed"
	/** A file the resolver pulled in mid-walk is outside the caller's scope. */
	| "inventory-scope-gap"
	// coverage
	| "raw-locators-disabled"
	| "unforwarded-prop";

export interface Diagnostic {
	code: DiagnosticCode;
	severity: DiagnosticSeverity;
	message: string;
	loc?: SourceLoc;
	data?: Record<string, string | number | boolean | null>;
}

/* -------------------------------------------------------------------------- */
/* Static values                                                              */
/* -------------------------------------------------------------------------- */

/** JSON encoding of a `RegExp` literal. */
export interface RegexValue {
	kind: "regex";
	source: string;
	flags: string;
}

export type StaticValue =
	| string
	| number
	| boolean
	| null
	| RegexValue
	| StaticValue[]
	| { [key: string]: StaticValue };

export type DynamicReason =
	| "computed-expression"
	| "template-literal"
	| "spread"
	| "identifier-unresolved"
	| "custom-selector"
	| "unsupported-syntax"
	/** Only matched a test id written as a prop on a component tag (see `TestIdOccurrence.unforwarded`). */
	| "unforwarded-prop";

export interface DynamicValue {
	kind: "dynamic";
	source: string;
	reason: DynamicReason;
}

export type MaybeStatic = StaticValue | DynamicValue;

/* -------------------------------------------------------------------------- */
/* Selectors                                                                  */
/* -------------------------------------------------------------------------- */

export type SelectorKind =
	| "self"
	| "testId"
	| "testIdPattern"
	| "role"
	| "text"
	| "label"
	| "placeholder"
	| "altText"
	| "title"
	| "custom";

/**
 * A test-id pattern.
 *
 * `matchMode` mirrors the runtime: `@ListSelector("CartItem_")` compiles to
 * `new RegExp("CartItem_")`, which is **unanchored** — it matches `CartItem_1`
 * but also `XCartItem_1`. A `RegExp` literal keeps whatever anchors it declared.
 */
export interface PatternInfo {
	source: string;
	flags: string;
	origin: "string" | "regex";
	matchMode: "regexUnanchored" | "regex";
	/** Leading literal run of the pattern, used as a cheap containment probe. */
	literalPrefix: string | null;
}

export interface SelectorInfo {
	kind: SelectorKind;
	/** Canonical library export name, e.g. `"Selector"`, `"SelectorByRole"`. */
	decorator: string;
	/** Decorator source text, whitespace-collapsed, capped at 200 chars. */
	raw: string;
	dynamic: boolean;
	testId?: MaybeStatic;
	pattern?: PatternInfo;
	role?: MaybeStatic;
	text?: MaybeStatic;
	options?: MaybeStatic;
	args?: MaybeStatic[];
	notes?: string[];
}

/* -------------------------------------------------------------------------- */
/* Page objects                                                               */
/* -------------------------------------------------------------------------- */

export type MemberResult =
	| { kind: "locator" }
	| {
			kind: "pageObject";
			ref: string | null;
			className: string;
			external?: boolean;
	  }
	| {
			kind: "list";
			listClassName: string;
			listRef: string | null;
			itemClassName: string | null;
			itemRef: string | null;
			itemDefaulted?: boolean;
	  }
	| {
			kind: "control";
			ref: string | null;
			className: string | null;
			viaInlineFactory?: boolean;
			dynamic?: boolean;
	  }
	| { kind: "unknown"; dynamic: true; source: string };

export interface MemberNode {
	name: string;
	loc: SourceLoc;
	doc?: string;
	visibility: "public" | "protected" | "private";
	isStatic?: boolean;
	selector: SelectorInfo;
	result: MemberResult;
	warnings?: Diagnostic[];
}

export interface MethodInfo {
	name: string;
	kind: "method" | "getter" | "setter";
	signature: string;
	isAsync: boolean;
	isStatic?: boolean;
	returnType: string | null;
	doc?: string;
	loc: SourceLoc;
}

export type HostKind =
	| "rootPageObject"
	| "rootPlain"
	| "pageFallback"
	| "fragment"
	| "nestedPageObject"
	| "externalControl"
	| "unknown";

export type HostScope = "body" | "root-selector" | "parent-locator" | "unknown";

export interface FixtureBinding {
	name: string;
	file: string;
	loc: SourceLoc;
	form: "constructor" | "factory" | "dynamic";
}

export interface PageObjectNode {
	id: string;
	className: string;
	file: string;
	loc: SourceLoc;
	hostKind: HostKind;
	scope: HostScope;
	rootSelector?: SelectorInfo;
	extendsChain: string[];
	inheritedApi: "PageObject" | "ListPageObject" | "RootPageObject" | null;
	ctorSignature?: string;
	doc?: string;
	fixtures?: FixtureBinding[];
	members: MemberNode[];
	methods: MethodInfo[];
	/** `false` when a depth or node budget stopped expansion. */
	expanded: boolean;
	/** `true` for synthetic stubs describing library-owned classes. */
	external?: boolean;
	warnings?: Diagnostic[];
}

/** Nested projection of {@link PageObjectTree.defs}, produced by `format: "inline"`. */
export interface InlinePageObjectNode {
	ref: string;
	className: string;
	file?: string;
	hostKind?: HostKind;
	repeated?: boolean;
	cyclic?: boolean;
	truncated?: boolean;
	members?: Array<{
		name: string;
		selector: SelectorInfo;
		result: MemberResult;
		child?: InlinePageObjectNode;
		item?: InlinePageObjectNode;
	}>;
	methods?: MethodInfo[];
}

export interface PageObjectTree {
	schemaVersion: 1;
	projectRoot: string;
	testIdAttribute: string;
	testIdAttributeSource: TestIdAttributeSource;
	/** Key into {@link defs}. */
	root: string;
	defs: Record<string, PageObjectNode>;
	/** Present only when `format: "inline"` was requested. */
	inline?: InlinePageObjectNode;
	warnings: Diagnostic[];
	truncated?: boolean;
	stats: {
		defs: number;
		members: number;
		methods: number;
		dynamic: number;
		parseMs: number;
	};
}

export type DiscoveryEvidence =
	| "decorator"
	| "baseClass"
	| "fixture"
	| "factoryArg";

export interface PageObjectSummary {
	id: string;
	className: string;
	file: string;
	loc: SourceLoc;
	hostKind: HostKind;
	scope: HostScope;
	rootSelector: SelectorInfo | null;
	extendsChain: string[];
	isExported: boolean;
	isDefaultExport: boolean;
	doc?: string;
	fixtures: FixtureBinding[];
	counts: { members: number; methods: number; dynamicMembers: number };
	discoveredBy: DiscoveryEvidence[];
	warnings: Diagnostic[];
}

export type TestIdAttributeSource = "playwright-config" | "default" | "param";

export interface PageObjectIndex {
	schemaVersion: 1;
	projectRoot: string;
	tsconfig: string | null;
	testIdAttribute: string;
	testIdAttributeSource: TestIdAttributeSource;
	pageObjects: PageObjectSummary[];
	warnings: Diagnostic[];
	stats: { filesScanned: number; parseMs: number; cached: boolean };
}

/* -------------------------------------------------------------------------- */
/* TSX / UI                                                                   */
/* -------------------------------------------------------------------------- */

export interface TestIdValue {
	kind: "static" | "pattern" | "dynamic";
	value?: string;
	prefix?: string;
	regex?: { source: string; flags: string };
	parts?: Array<
		{ kind: "literal"; text: string } | { kind: "expr"; text: string }
	>;
	raw: string;
	reason?: DynamicReason;
}

/**
 * Why a node's subtree is missing, unproven, or unreadable.
 *
 * Everything except `"spread-props"` is a *structural* hole: the runtime tree
 * has content the walk could not put in `roots`. `"spread-props"` is a value
 * hole on a node whose children are present.
 */
export type UiUnresolvedReason =
	/* component boundaries — the callee's own subtree is missing */
	| "external-module"
	| "identifier-unresolved"
	| "namespaced-component"
	| "not-a-function-component"
	/** The component renders itself on the current ancestor path; the walk cut the cycle. */
	| "recursive"
	/** The caller asked for one level only (`followComponents: false`). Not a budget cut. */
	| "not-followed"
	| "depth-limit-reached"
	| "node-budget-reached"
	/* content the walk could see but not place */
	/** The expression syntactically contains JSX the walk could not attach to a node. */
	| "unresolved-jsx"
	/** An expression that may render UI (a call, an unresolved identifier, a render prop). */
	| "opaque-expression"
	/* value-level, not structural */
	| "spread-props";

export interface UiNode {
	tag: string;
	/**
	 * `"unresolved"` is a synthetic marker node (`tag: "#unresolved"`) standing in
	 * for content the walk could see was there but could not resolve into nodes.
	 * It never has children and never carries a test id.
	 */
	nodeType: "element" | "component" | "branch" | "unresolved";
	testId?: TestIdValue;
	file: string;
	loc: SourceLoc;
	/** Enclosing component name at the declaration site. */
	component: string;
	conditional?: boolean;
	/** Rendered inside a `.map(...)` callback. */
	repeated?: boolean;
	componentRef?: string;
	/**
	 * Set on a component node whose subtree was already expanded at an earlier
	 * render site in this same tree, pointing at that site's `loc`. `children`
	 * holds only the nodes *this* site passed in as content — every one of them
	 * carries {@link UiNode.placement}. The component's own subtree was expanded
	 * at the referenced location; read the children there that have no
	 * `placement`. Only ever set when the two expansions would be identical.
	 */
	expandedAt?: SourceLoc;
	/**
	 * How this node reached its parent, when the parent is a component element.
	 *
	 * Absent means the ordinary case: the parent renders this node in the position
	 * the source shows. When present, the JSX is declared by the *caller* and was
	 * handed to the parent component as content — so it is the caller's own source
	 * and is walked as such, but **where, or whether, the parent renders it is not
	 * proven**. Read the subtree as "renders somewhere inside this component, or
	 * not at all".
	 *
	 * - `kind: "slot"` — passed as the parent's children (JSX between its tags, or
	 *   an explicit `children={…}` attribute).
	 * - `kind: "prop"` — passed as the value of another prop.
	 *
	 * `name` is `"children"` for a slot, otherwise the attribute name.
	 *
	 * Only the *top* node of each passed expression carries this. Its descendants
	 * have proven placement relative to their own parent.
	 */
	placement?: { kind: "slot" | "prop"; name: string };
	viaProp?: string;
	viaSpread?: boolean;
	/**
	 * The id came from the component's own fallback — a parameter default
	 * (`{ testId = "Row" }`) or a `prop || "Row"` / `prop ?? "Row"` expression —
	 * because the call site provably passed nothing. `viaProp` names the prop that
	 * was absent.
	 */
	viaDefault?: true;
	/**
	 * The element writes the test-id attribute, but at this render site the value
	 * provably resolves to nothing: it reads a prop the call site did not pass,
	 * the call site spreads nothing, and the prop declares no default. The
	 * attribute is absent from the DOM here — do not write a selector for it.
	 *
	 * Only ever set when the call site is known, so never on the tree root, whose
	 * caller is outside the analysed tree.
	 */
	testIdAbsent?: true;
	unresolved?: { reason: UiUnresolvedReason };
	children: UiNode[];
}

export interface TestIdOccurrence {
	value: TestIdValue;
	file: string;
	loc: SourceLoc;
	tag: string;
	component: string;
	conditional?: boolean;
	repeated?: boolean;
	viaProp?: string;
	/**
	 * The attribute sits on a *component* tag, so it is a prop rather than a DOM
	 * attribute: `<Card data-testid="save"/>` renders that id only if `Card`
	 * forwards the prop to a host element, and a component that ignores it makes
	 * the id disappear at runtime.
	 *
	 * The occurrence is kept — it is a real fact about the source — but coverage
	 * treats it as unproven rather than rendered. Forwarding that the tree walk
	 * *does* prove is recorded as its own occurrence on the host element, with
	 * `viaProp` / no flag, and that one is what coverage matches against.
	 */
	unforwarded?: true;
}

export interface ComponentInfo {
	id: string;
	name: string;
	file: string;
	loc: SourceLoc;
	propNames: string[];
	forwardsSpread: boolean;
	exportKind: "default" | "named";
}

export interface TestIdTree {
	schemaVersion: 1;
	/** Reserved for future `"vue-sfc"` / `"svelte"` / `"angular-html"` scanners. */
	scanner: "jsx";
	attribute: string;
	attributeSource: TestIdAttributeSource;
	/**
	 * Completeness of the **node tree**, not of individual test ids.
	 *
	 * - `"full"` — the walk reached everything: no node carries a structural
	 *   `unresolved` reason and no budget cut fired.
	 * - `"partial"` — the walk ran, but at least one subtree is missing or its
	 *   placement is unproven. `roots` is real but has holes; `fidelityReason`
	 *   and `stats.unresolvedByReason` say where. Never treat the absence of a
	 *   test id in a partial tree as proof it is not rendered.
	 * - `"flat"` — no entry component could be rooted; `roots` is empty and only
	 *   `inventory` is meaningful.
	 *
	 * `inventory` is complete in all three states.
	 */
	fidelity: "full" | "partial" | "flat";
	/** Always present when `fidelity !== "full"`. */
	fidelityReason?: string;
	roots: UiNode[];
	/** Always complete across every scanned file, whatever the fidelity. */
	inventory: TestIdOccurrence[];
	components: Record<string, ComponentInfo>;
	warnings: Diagnostic[];
	truncated?: boolean;
	stats: {
		files: number;
		occurrences: number;
		dynamic: number;
		parseMs: number;
		/** Nodes emitted into `roots`. */
		nodes: number;
		/** Nodes with a structural `unresolved` reason (`spread-props` excluded). */
		unresolved: number;
		/** Breakdown of `unresolved` by reason code. */
		unresolvedByReason: Record<string, number>;
		/** Nodes carrying `placement` — content whose DOM position is unproven. */
		slots: number;
	};
}

/* -------------------------------------------------------------------------- */
/* Playwright config                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Which layer of the config stack the resolved `testIdAttribute` came from.
 *
 * A Playwright config is routinely a merge — `defineConfig({ ...base, … })`, or
 * a leaf config importing a shared base one directory up. Reporting only the
 * chosen *file* would name a file that does not contain the attribute at all.
 */
export type TestIdAttributeOrigin =
	/** Written in the chosen config's own object literal. */
	| "primary"
	/** Written in an argument of a merge helper call in the chosen config. */
	| "merge-layer"
	/** Written in a config the chosen one imports (one hop). */
	| "base-config"
	/** Written in an object spread into the chosen config's literal. */
	| "spread"
	/** Not in the chosen config at all; read from another discovered config. */
	| "sibling-config";

export interface PlaywrightConfigInfo {
	configFile: string | null;
	/**
	 * Every discovered config, ranked, workspace-relative. The chosen one is
	 * first when discovery picked it; an explicit path is not in this list unless
	 * discovery found it too.
	 */
	candidates: string[];
	/** Whether {@link configFile} was chosen by discovery or supplied by the caller. */
	configSource: "discovered" | "explicit" | "none";
	testIdAttribute: string | undefined;
	/** Where the resolved {@link testIdAttribute} was written; absent when unresolved. */
	testIdAttributeFrom?: TestIdAttributeOrigin;
	/** Workspace-relative posix dir, already resolved against the config's own directory. */
	testDir: string | undefined;
	/**
	 * `testDir` is written in the config but is not a string literal
	 * (`testDir: process.env.DIR`), so its value is unknown rather than absent.
	 *
	 * The two cases are not interchangeable: an absent `testDir` means Playwright's
	 * own default, the config file's directory, while an unresolved one means the
	 * directory is anything *but* that default, and guessing it would scope the
	 * analysis to a tsconfig Playwright never reads.
	 */
	testDirUnresolved?: true;
	projectOverrides: Array<{
		project: string | null;
		testIdAttribute: string;
		loc: SourceLoc;
	}>;
	notes: Diagnostic[];
}

/* -------------------------------------------------------------------------- */
/* Coverage                                                                   */
/* -------------------------------------------------------------------------- */

export type MatchConfidence =
	| "exact"
	| "pattern"
	| "regex"
	| "probe"
	| "prefix";

export interface SelectorUsage {
	defId: string;
	memberPath: string;
	loc: SourceLoc;
	kind: SelectorKind;
	text: string;
	testId?: string;
	pattern?: PatternInfo;
	dynamic: boolean;
	reason?: DynamicReason;
	origin: "page-object" | "raw";
}

export interface UiTestId {
	id: string | null;
	patternSource: string | null;
	patternFlags?: string;
	prefix?: string | null;
	occurrences: TestIdOccurrence[];
}

export interface CoverageReport {
	schemaVersion: 1;
	attribute: string;
	summary: {
		uiTestIds: number;
		matchableUiTestIds: number;
		coveredUiTestIds: number;
		testIdSelectors: number;
		deadSelectors: number;
		nonTestIdSelectors: number;
		unknownSelectors: number;
		unknownTestIds: number;
		/** `coveredUiTestIds / matchableUiTestIds`, 0..1. `1` when nothing is matchable. */
		coverage: number;
	};
	matched: Array<{
		selector: {
			defId: string;
			memberPath: string;
			loc: SourceLoc;
			kind: SelectorKind;
			text: string;
		};
		ui: {
			id: string | null;
			patternSource: string | null;
			occurrences: SourceLoc[];
		};
		confidence: MatchConfidence;
		probe?: string;
	}>;
	uncoveredTestIds: Array<{
		id: string | null;
		patternSource: string | null;
		occurrences: TestIdOccurrence[];
		suggestion: string;
	}>;
	deadSelectors: Array<{
		defId: string;
		memberPath: string;
		loc: SourceLoc;
		text: string;
		nearestTestIds: string[];
	}>;
	nonTestIdSelectors: Array<{
		kind: SelectorKind;
		defId: string;
		memberPath: string;
		loc: SourceLoc;
		text: string;
	}>;
	unknownSelectors: Array<{
		defId: string;
		memberPath: string;
		loc: SourceLoc;
		reason: DynamicReason;
		raw: string;
	}>;
	unknownTestIds: TestIdOccurrence[];
	warnings: Diagnostic[];
}
