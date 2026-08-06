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
	| "config-shape-unrecognized"
	| "testid-attribute-unresolved"
	| "testid-attribute-maybe-spread"
	| "testid-attribute-project-override"
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

export interface UiNode {
	tag: string;
	nodeType: "element" | "component" | "branch";
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
	 * render site in this same tree, pointing at that site's `loc`. `children` is
	 * empty: read the subtree there instead. Only ever set when the two sites
	 * would have produced identical subtrees.
	 */
	expandedAt?: SourceLoc;
	viaProp?: string;
	viaSpread?: boolean;
	unresolved?: { reason: string };
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
	fidelity: "full" | "flat";
	fidelityReason?: string;
	roots: UiNode[];
	/** Always complete across every scanned file, even when `fidelity === "flat"`. */
	inventory: TestIdOccurrence[];
	components: Record<string, ComponentInfo>;
	warnings: Diagnostic[];
	truncated?: boolean;
	stats: {
		files: number;
		occurrences: number;
		dynamic: number;
		parseMs: number;
	};
}

/* -------------------------------------------------------------------------- */
/* Playwright config                                                          */
/* -------------------------------------------------------------------------- */

export interface PlaywrightConfigInfo {
	configFile: string | null;
	testIdAttribute: string | undefined;
	/** Workspace-relative posix dir, already resolved against the config's own directory. */
	testDir: string | undefined;
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
