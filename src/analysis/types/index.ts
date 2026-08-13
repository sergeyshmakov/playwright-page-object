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
/* Test-id values                                                             */
/* -------------------------------------------------------------------------- */

/** One segment of a template-built id: written text, or a hole. */
export type TestIdPart =
	| { kind: "literal"; text: string }
	| { kind: "expr"; text: string };

/**
 * A test-id value as the scan read it, in the three states it can be in.
 *
 * A union rather than a `kind` beside five independent optionals, which is what
 * `MemberResult` and `MaybeStatic` - the same static-or-dynamic idea, twice
 * more in this file - already are. The producers always held the invariant:
 * `staticValue` cannot omit `value`, `patternFromParts` cannot omit `regex`.
 * Only the type failed to say so, and nine call sites re-proved it by hand, one
 * of them casting against this very declaration to read a `prefix` that was
 * already on it.
 *
 * The JSON is unchanged: these are the same objects the scan always produced.
 */
export type TestIdValue =
	| { kind: "static"; value: string; raw: string }
	| {
			kind: "pattern";
			regex: { source: string; flags: string };
			parts: TestIdPart[];
			/**
			 * Leading literal run, used as a cheap containment probe. Genuinely
			 * absent when the template opens with a hole - `${prefix}Row` has none.
			 */
			prefix?: string;
			raw: string;
	  }
	| { kind: "dynamic"; reason: DynamicReason; raw: string };

/**
 * Why a node's subtree is missing, unproven, or unreadable.
 *
 * Everything except `"spread-props"` is a *structural* hole: the runtime tree
 * has content the walk could not put in `roots`. `"spread-props"` is a value
 * hole on a node whose children are present.
 */

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
/* The three payload shapes, re-exported so `…/types` stays one specifier      */
/* -------------------------------------------------------------------------- */

export type * from "./coverage";
export type * from "./pageObjects";
export type * from "./ui";
