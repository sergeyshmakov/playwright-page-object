/**
 * The shape of a coverage report on the wire.
 *
 * Split out of `types.ts` on the section dividers it already carried. Every
 * name still reaches callers through `…/types`, which re-exports all three.
 */

import type { Diagnostic, DynamicReason, SourceLoc } from "./index";
import type { PatternInfo, SelectorKind } from "./pageObjects";
import type { TestIdOccurrence } from "./ui";

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
	 * The weaker match is reported rather than deleted - but the list itself is
	 * trimmed, so read {@link alsoMatchesRenderedTotal} before treating its
	 * length as the count.
	 */
	alsoMatchesRendered?: string[];
	/** How many there were, when more matched than the list carries. */
	alsoMatchesRenderedTotal?: number;
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
		/**
		 * Every proven render site for this id. Read `loc.file`, `loc.line` and the
		 * optional `loc.column`; `conditional` and `repeated` retain the JSX context
		 * needed to choose between a singleton and list selector.
		 */
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
