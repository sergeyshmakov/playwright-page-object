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
	/** Another discovered config sets an attribute; it was reported, not applied. */
	| "testid-attribute-sibling"
	| "testid-attribute-conflict"
	// environment sanity
	| "attribute-mismatch"
	| "attribute-no-evidence"
	| "scope-empty"
	| "scope-dir-missing"
	/** The scan is large enough to be worth stating: it is most of the memory. */
	| "large-scan"
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
	/** Ids written as a prop on a component tag with no forwarding proven. */
	| "testid-forwarding-unproven"
	/** `assumeForwarded` was on, so unproven prop ids were counted as rendered. */
	| "forwarding-assumed"
	/** Enough selectors land on unproven props that the report is worth re-running. */
	| "forwarding-unproven-widespread"
	/** A test-id pattern matches every id, so it can prove nothing about any of them. */
	| "unanchored-testid-pattern"
	/** Nothing in the scan is matchable, so the coverage ratio has no denominator. */
	| "no-matchable-testids"
	/** The page-object side was scoped while the UI side stayed project-wide. */
	| "coverage-scope-narrowed"
	/** Component tags come from modules outside the scanned sources. */
	| "ui-scope-incomplete";

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
	/**
	 * Only matched a test id written as a prop on a component tag, and nothing
	 * proved the component forwards it (see `TestIdOccurrence.reach`).
	 */
	| "forwarding-unproven"
	/**
	 * The pattern has no literal anchor left once its `.+` / `.*` holes are
	 * removed, so it matches every id and proves nothing about any of them.
	 */
	| "unanchored-pattern"
	/**
	 * The selector's literal appears inside a test id the source builds at
	 * runtime, so the element probably exists but the value cannot be read.
	 */
	| "dynamic-testid-expression"
	/**
	 * This run had no rendered and no prop-written test id to compare against,
	 * so no selector could be judged either way.
	 *
	 * "Dead" is a claim about a set of ids the application renders; with an empty
	 * set the claim is vacuous, and a report that called 1454 working selectors
	 * dead because the attribute was misread is the most alarming thing this tool
	 * can print. The remedy is in the `no-matchable-testids` warning: fix the
	 * attribute or the scope and run again.
	 */
	| "no-ui-evidence";

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
	/**
	 * `private` and `#private` members are never reported at all, so the only two
	 * states a listed method can be in are the two a test author can call.
	 */
	visibility: "public" | "protected";
	isStatic?: boolean;
	/** Declared on a project-local base class rather than on this one. */
	inherited?: true;
	/** Name of the class that declares it. Only set when {@link inherited}. */
	declaredIn?: string;
	/**
	 * Written as a class property holding a function (`run = async () => {}`)
	 * rather than with method syntax. It is callable all the same, but it is an
	 * own property, so it shadows rather than overrides.
	 */
	declaredAsProperty?: true;
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
	/**
	 * A call to a same-file function that returns JSX — `{getCheckinIcon()}` — that
	 * the walk could not inline: it calls itself on this path, or its body produced
	 * no node. `raw` carries the call as written.
	 *
	 * Only ever emitted with positive evidence that the callee *is* a local render
	 * helper (a same-file arrow, function expression or function declaration whose
	 * body contains JSX). An ordinary call — `{t("label")}` — is not this, and gets
	 * no marker.
	 */
	| "local-render-function"
	/**
	 * The same shape one module away: `{renderRow()}` whose `renderRow` is
	 * imported from another file in this repository and returns JSX. Its subtree
	 * is not inlined — the nodes would be attributed to the caller's file, which
	 * is not where they are written — but the call is reported, because silence
	 * here left the ids it renders missing from the tree with `fidelity: "full"`
	 * over the top and `traversalGap` returning null.
	 *
	 * Held to the same evidence bar as `local-render-function`: the callee has to
	 * resolve to in-repo source whose body contains JSX. An imported `t("label")`
	 * is not this and gets no marker; neither does a call into a package, where
	 * nothing can tell the two apart.
	 */
	| "imported-render-function"
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
	/**
	 * The other ids this one element renders, when its attribute writes a static
	 * choice: `data-testid={big ? "Main" : "Alt"}` and the same ternary spelled
	 * inside a template both render one of several ids, exactly one per render.
	 *
	 * `testId` holds the first branch and this holds the rest, so a reader that
	 * knows only `testId` still sees a real id — but every branch is here, and the
	 * node is `conditional`. Dropping them made the tree contradict the flat
	 * inventory, which has always carried one occurrence per branch: a selector
	 * for the second branch looked dead in the tree and alive in coverage.
	 */
	testIdAlternatives?: TestIdValue[];
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
	/**
	 * `raw` is the source text of what could not be resolved, collapsed to one
	 * line and truncated. Present only where the reason is about a specific
	 * expression the reader would otherwise have to go and find — a call to a
	 * local render helper names the helper — and absent where the reason already
	 * says everything (a depth limit, an external module).
	 */
	unresolved?: { reason: UiUnresolvedReason; raw?: string };
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
	 * How far the written attribute was proven to travel towards the DOM.
	 *
	 * - `"element"` — written directly on a host element. It renders.
	 * - `"forwarded"` — written as a prop somewhere, and the walk proved it lands
	 *   on a host element here. It renders.
	 * - `"component-prop"` — written on a *component* tag and nothing proved it
	 *   goes any further: `<Card data-testid="save"/>` renders that id only if
	 *   `Card` passes the prop to a host element, and a component that ignores it
	 *   makes the id disappear at runtime.
	 *
	 * The occurrence is kept in every case — it is a real fact about the source —
	 * but coverage counts only the first two as rendered. Required rather than
	 * optional on purpose: "the flag is absent" and "the reach is unknown" are
	 * not the same claim, and reading one as the other is what makes a coverage
	 * number confidently wrong.
	 */
	reach: "element" | "forwarded" | "component-prop";
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
	/**
	 * Non-relative module specifiers that supply component tags the scan could
	 * not resolve to a file inside the workspace. Sorted, capped at 10.
	 *
	 * Evidence of *scope*, not of failure: a repository whose components come
	 * from a sibling package nobody put in scope renders test ids this scan can
	 * never see, and a coverage report that does not say so reads as proof those
	 * ids do not exist.
	 */
	externalModules: string[];
	/**
	 * How many distinct such specifiers there are, which is **not**
	 * `externalModules.length` once there are more than ten of them: that array
	 * is a display sample. Anything reporting a count must read this.
	 */
	externalModuleCount: number;
	/**
	 * External specifiers whose sources were found inside this repository — the
	 * only ones {@link externalModuleRoot} is derived from, and so the only ones
	 * anything may claim have sources here. Sorted and capped independently, so
	 * this is a subset of *all* external specifiers rather than of the
	 * `externalModules` sample: either list can omit an entry the other shows.
	 */
	linkedExternalModules: string[];
	/** How many are linked, for the same reason as {@link externalModuleCount}. */
	linkedExternalModuleCount: number;
	/**
	 * Directory to root an analysis at so those modules' sources come into scope,
	 * present only when at least one of them *has* sources here: a package linked
	 * into `node_modules` from elsewhere in the repository, which is the workspace
	 * monorepo shape. Absent when the tags come from installed packages or from
	 * specifiers that do not resolve, where no scope change can reach them.
	 *
	 * The distinction exists because the two cases take opposite advice, and one
	 * of them takes advice that cannot be followed: widening the scanned
	 * directories to a path outside the analysed root contributes nothing.
	 */
	externalModuleRoot?: string;
	warnings: Diagnostic[];
	truncated?: boolean;
	stats: {
		files: number;
		occurrences: number;
		dynamic: number;
		parseMs: number;
		/** Component tags resolved to one of {@link TestIdTree.externalModules}. */
		externalComponentTags: number;
		/** Nodes emitted into `roots`. */
		nodes: number;
		/**
		 * Nodes in `roots` carrying a structural `unresolved` reason — a subtree
		 * the walk could not produce. `spread-props` is excluded: it marks an
		 * unknown *value* on a node whose children are all present.
		 */
		unresolved: number;
		/**
		 * `unresolved` broken down by reason, counted over the same emitted nodes.
		 * Reasons that did not occur are omitted rather than reported as `0`, so
		 * the keys are exactly the holes this tree has.
		 *
		 * This is the machine-readable form of what `fidelityReason` says in
		 * prose; the prose is rendered from these counts, so the two cannot
		 * disagree.
		 */
		unresolvedByReason: Partial<Record<UiUnresolvedReason, number>>;
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
 *
 * Every origin is a layer of the chosen config's own expression. A config the
 * chosen one does not reference is not one of them: it has no runtime
 * relationship to this run, so its attribute is reported as a
 * `testid-attribute-sibling` note and never becomes the effective value.
 */
export type TestIdAttributeOrigin =
	/** Written in the chosen config's own object literal. */
	| "primary"
	/** Written in an argument of a merge helper call in the chosen config. */
	| "merge-layer"
	/** Written in a config the chosen one imports (one hop). */
	| "base-config"
	/** Written in an object spread into the chosen config's literal. */
	| "spread";

export interface PlaywrightConfigInfo {
	configFile: string | null;
	/**
	 * Ranked, workspace-relative configs that *discovery* found — a capped subset,
	 * not an inventory.
	 *
	 * The chosen one is first. The list is capped at the discovery limit, and
	 * {@link candidatesTruncated} says when the cap dropped some. It is empty for
	 * an explicitly named config, because naming one suppresses discovery
	 * entirely: there is no ranked list to report, not even a list of one.
	 */
	candidates: string[];
	/** `true` when discovery ranked more configs than {@link candidates} keeps. */
	candidatesTruncated?: true;
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

/**
 * *How* a selector's test id matched a rendered one — not how likely the
 * selector is to work.
 *
 * The distinction matters and the name does not carry it. `"exact"` means the
 * two strings were equal, and nothing more: coverage compares ids across the
 * whole application, because nothing statically ties a page object to a DOM
 * subtree, so an `Info` selector matches every rendered `Info` anywhere. A
 * reader who takes `"exact"` for "this selector resolves to this element" has
 * been told something the analysis never claimed — see `unprovenOccurrences` on
 * the match entry, which names the ambiguity the label cannot.
 */
export type MatchConfidence =
	/** The two id strings are equal. Says nothing about which element is hit. */
	"exact" | "pattern" | "regex" | "probe" | "prefix";

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
	/**
	 * The group only exists in the rendered side because `assumeForwarded` was
	 * on: every occurrence in it is a `component-prop`.
	 */
	assumed?: true;
}

/** Where a selector was written: in a page-object class, or inline in a call. */
export type SelectorOrigin = "page-object" | "raw";

/** A UI test id coverage could not treat as rendered, and why. */
export interface UnknownTestId {
	reason: "dynamic-value" | "forwarding-unproven" | "unanchored-pattern";
	occurrence: TestIdOccurrence;
	/** The offending pattern, for `"unanchored-pattern"`. */
	patternSource?: string;
}

/** What the report knows about a selector it could neither match nor call dead. */
export interface UnknownSelectorEvidence {
	/** Rendered-but-unproven ids the selector matched. */
	testIds?: string[];
	/** Where one of those ids is written. */
	loc?: SourceLoc;
	/** Source text of the dynamic expression the selector's literal appears in. */
	raw?: string;
	/**
	 * Ids the selector would also have matched, outranked by the evidence above.
	 * Nothing is silently dropped: the weaker match is reported, not deleted.
	 */
	alsoMatchesRendered?: string[];
}

/** The six lists a {@link CoverageReport} ships, as addressable names. */
export type CoverageBucket =
	| "matched"
	| "uncoveredTestIds"
	| "deadSelectors"
	| "nonTestIdSelectors"
	| "unknownSelectors"
	| "unknownTestIds";

export interface CoverageReport {
	schemaVersion: 1;
	attribute: string;
	summary: {
		uiTestIds: number;
		matchableUiTestIds: number;
		coveredUiTestIds: number;
		testIdSelectors: number;
		/** Selectors read from direct locator calls rather than from a decorator. */
		rawSelectors: number;
		/** Length of `matched`, which counts pairs and so can exceed either side. */
		matched: number;
		deadSelectors: number;
		nonTestIdSelectors: number;
		unknownSelectors: number;
		unknownTestIds: number;
		/** Length of `uncoveredTestIds`, so a capped list still reports its size. */
		uncoveredTestIds: number;
		/** Ids quarantined for matching everything (see `unanchored-pattern`). */
		catchAllTestIds: number;
		/** Prop ids promoted to rendered because `assumeForwarded` was on. */
		assumedForwardedTestIds?: number;
		/** Static rendered ids the selectors were compared against. */
		staticUiIdsCompared: number;
		/**
		 * `coveredUiTestIds / matchableUiTestIds`, 0..1, or `null`.
		 *
		 * Null for either of the two runs where the division has no meaning, each
		 * with a warning naming which: nothing was matchable
		 * (`no-matchable-testids`), or the page-object side was scoped to a class or
		 * a file while the UI side stayed project-wide
		 * (`coverage-scope-narrowed`). Both used to ship a number — `1` for zero of
		 * zero, and a fraction of a percent for a single page object measured
		 * against a whole application — and this is the one number in the report
		 * nobody double-checks.
		 */
		coverage: number | null;
	};
	/** What the two sides of the comparison were drawn from. */
	scope: {
		uiFilesScanned: number;
		pageObjectFilesScanned: number;
		/** Non-relative modules supplying component tags, sorted, capped at 10. */
		externalComponentModules: string[];
		externalComponentTags: number;
	};
	matched: Array<{
		selector: {
			defId: string;
			memberPath: string;
			loc: SourceLoc;
			kind: SelectorKind;
			text: string;
			origin: SelectorOrigin;
		};
		ui: {
			id: string | null;
			patternSource: string | null;
			occurrences: SourceLoc[];
		};
		confidence: MatchConfidence;
		probe?: string;
		/** The id only counts as rendered because `assumeForwarded` was on. */
		forwarding?: "assumed";
		/**
		 * This selector *also* reaches this many component-prop sites that nothing
		 * proved reach the DOM.
		 *
		 * A match is only ever made against proven elements, so `occurrences` above
		 * is sound. This says the selector has a second life the match did not
		 * consider — and on a real repository that is where a broken selector hides:
		 * the entry looks clean because some *other* component renders a matching
		 * id, while the site the page object was written for forwards a prop nobody
		 * can follow.
		 *
		 * Judged against the selector rather than against the id it matched on,
		 * because a pattern, probe or prefix match has no id at all — keying on one
		 * silently skipped every speculative match, which is the set least able to
		 * speak for itself.
		 */
		unprovenOccurrences?: number;
		/** First of those sites, so the caller can go and look. */
		unprovenAt?: SourceLoc;
	}>;
	uncoveredTestIds: Array<{
		id: string | null;
		patternSource: string | null;
		occurrences: TestIdOccurrence[];
		suggestion: string;
		/**
		 * Selectors that matched this id speculatively but were credited to a
		 * stronger piece of evidence elsewhere. It may well be covered.
		 */
		speculativeSelectors?: string[];
	}>;
	deadSelectors: Array<{
		defId: string;
		memberPath: string;
		loc: SourceLoc;
		text: string;
		origin: SelectorOrigin;
		nearestTestIds: string[];
		/**
		 * The scan could not see all the UI this repository renders, so **read
		 * "dead" as "unverified"**: component tags resolve to modules outside the
		 * scanned sources (`scope.externalComponentModules` names them, and the
		 * `ui-scope-incomplete` warning says how many). The id may well be rendered
		 * inside one of them. Set on every entry of a run that has that evidence,
		 * and absent entirely from a run that does not.
		 *
		 * Uniform on purpose. Nothing statically ties one selector to one unscanned
		 * module — a page object imports no components, it names strings — so a
		 * per-entry discriminator would be a guess wearing the clothes of evidence.
		 * The discriminator that *is* evidence sits next to it: `nearestTestIds`
		 * non-empty reads as a rename or a typo, empty alongside this flag reads as
		 * an artifact of the scope. The flag also survives truncation, which the
		 * warning does not — a caller reading one entry, or a list capped by
		 * `limit`, still sees the caveat.
		 */
		scopeIncomplete?: true;
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
		origin: SelectorOrigin;
		evidence?: UnknownSelectorEvidence;
	}>;
	unknownTestIds: UnknownTestId[];
	warnings: Diagnostic[];
}
