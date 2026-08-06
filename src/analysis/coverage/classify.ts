import type {
	MatchConfidence,
	PatternInfo,
	TestIdOccurrence,
	UiTestId,
} from "../types";
import {
	isCatchAllUi,
	type MatchOutcome,
	prefixOverlap,
	probesFromPattern,
	type SelectorSide,
} from "./match";

/**
 * The evidence ladder one selector is judged on.
 *
 * Coverage used to ask a single question — "does this selector match anything
 * rendered?" — and answer `matched` or `dead`. That collapses six different
 * situations into two verdicts, and in the field it got all the interesting
 * ones wrong: an id proven only as a component prop was promoted into
 * `matched`, and an id the report itself listed under `unknownTestIds` was
 * simultaneously declared dead, so the same run said "we could not read this"
 * and "this does not exist".
 *
 * The ladder makes the ranking explicit. Strong evidence outranks weak, proven
 * outranks speculative, and — the part that matters — the outranked evidence is
 * reported rather than discarded, so a reader can always see the second-best
 * explanation the report considered.
 *
 * - **A — direct rendered.** The exact id, or the selector's own regex, hits an
 *   id proven to reach the DOM. Nothing beats this.
 * - **B — direct prop.** Same strength of hit, but against an id that is only
 *   written as a prop on a component tag. The selector probably works; nobody
 *   proved it. Never `matched`, never `dead`.
 * - **C — speculative rendered.** A pattern on one side and a concrete value on
 *   the other, reconciled by probing. Real, but inferred.
 * - **D — speculative prop.** C's reasoning against B's evidence.
 * - **E — containment.** The selector's literal appears inside a test id the
 *   source builds at runtime. Not a match, but proof the id is not invented.
 * - **F — dead.** Everything else, and only after all five have failed.
 */
export type EvidenceStage = "A" | "B" | "C" | "D" | "E" | "F";

/** One selector paired with one UI test id it explains. */
export interface Match {
	ui: UiTestId;
	outcome: MatchOutcome;
}

/** A UI pattern with everything derived from it computed once. */
export interface PatternSide {
	ui: UiTestId;
	regex: RegExp | null;
	probes: string[];
}

/**
 * The UI side, indexed once per report.
 *
 * The naive form of this comparison is a nested loop that calls `new RegExp`
 * inside it: 1340 selectors against several thousand ids is seven figures of
 * regex compilation. Everything compilable is compiled here instead.
 */
export interface ClassifySides {
	renderedById: Map<string, UiTestId>;
	renderedStatic: UiTestId[];
	renderedPatterns: PatternSide[];
	propById: Map<string, UiTestId>;
	propStatic: UiTestId[];
	propPatterns: PatternSide[];
	/** Ids the scan could not read at all, for the containment probe. */
	unknownRaw: TestIdOccurrence[];
}

export type SelectorClassification =
	| { stage: "A" | "C"; verdict: "matched"; matches: Match[] }
	| {
			stage: "B" | "D";
			verdict: "forwarding-unproven";
			matches: Match[];
			/** Rendered ids a lower rung would have matched. Reported, not dropped. */
			outranked: Match[];
	  }
	| {
			stage: "E";
			verdict: "dynamic-testid-expression";
			literal: string;
			occurrences: TestIdOccurrence[];
	  }
	| { stage: "F"; verdict: "dead" };

/**
 * Shortest literal worth searching for inside a runtime-built id.
 *
 * Two characters match by accident in any repository with more than a handful
 * of ids; three is where containment starts carrying information.
 */
export const MIN_CONTAINMENT_LITERAL = 3;

/**
 * Compiles a selector pattern for repeated use.
 *
 * `g` and `y` are dropped deliberately: they make `RegExp.test` stateful
 * through `lastIndex`, so a compiled-once regex would match every other id.
 * Nothing about a locator's semantics depends on either flag.
 */
export function compilePattern(pattern: PatternInfo): RegExp | null {
	try {
		return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
	} catch {
		return null;
	}
}

/** Builds the compiled, probe-expanded form of one UI pattern group. */
export function toPatternSide(ui: UiTestId): PatternSide {
	let regex: RegExp | null = null;
	if (ui.patternSource !== null) {
		try {
			regex = new RegExp(
				ui.patternSource,
				(ui.patternFlags ?? "").replace(/[gy]/g, ""),
			);
		} catch {
			regex = null;
		}
	}
	return { ui, regex, probes: probesFromPattern(ui) };
}

/** Indexes one side's groups into the maps and lists `classifySelector` reads. */
export function indexSide(groups: UiTestId[]): {
	byId: Map<string, UiTestId>;
	statics: UiTestId[];
	patterns: PatternSide[];
} {
	const byId = new Map<string, UiTestId>();
	const statics: UiTestId[] = [];
	const patterns: PatternSide[] = [];
	for (const ui of groups) {
		if (ui.id !== null) {
			byId.set(ui.id, ui);
			statics.push(ui);
			continue;
		}
		// A catch-all never reaches here in the normal pipeline, which quarantines
		// it up front. Belt and braces: indexing one would hand every selector a
		// free match and empty the dead list, which is the exact field failure.
		if (!isCatchAllUi(ui)) {
			patterns.push(toPatternSide(ui));
		}
	}
	return { byId, statics, patterns };
}

/** Exact id, or the selector's own regex, against ids with a static value. */
function directMatches(
	selector: SelectorSide,
	regex: RegExp | null,
	byId: Map<string, UiTestId>,
	statics: UiTestId[],
): Match[] {
	if (selector.testId !== undefined) {
		const ui = byId.get(selector.testId);
		return ui ? [{ ui, outcome: { confidence: "exact" } }] : [];
	}
	if (!regex) {
		return [];
	}
	const out: Match[] = [];
	for (const ui of statics) {
		if (ui.id !== null && regex.test(ui.id)) {
			out.push({ ui, outcome: { confidence: "regex" as MatchConfidence } });
		}
	}
	return out;
}

/** A concrete value or a pattern reconciled against ids that are patterns. */
function speculativeMatches(
	selector: SelectorSide,
	regex: RegExp | null,
	patterns: PatternSide[],
): Match[] {
	const out: Match[] = [];
	for (const side of patterns) {
		if (selector.testId !== undefined) {
			if (side.regex?.test(selector.testId)) {
				out.push({ ui: side.ui, outcome: { confidence: "pattern" } });
			}
			continue;
		}
		if (!regex || !selector.pattern) {
			continue;
		}
		let hit: MatchOutcome | null = null;
		for (const probe of side.probes) {
			if (regex.test(probe)) {
				hit = { confidence: "probe", probe };
				break;
			}
		}
		if (!hit && prefixOverlap(selector.pattern, side.ui)) {
			hit = { confidence: "prefix" };
		}
		if (hit) {
			out.push({ ui: side.ui, outcome: hit });
		}
	}
	return out;
}

/**
 * Walks one selector down the evidence ladder and stops at the first rung that
 * explains it.
 *
 * Pure: no workspace, no diagnostics, no ordering side effects. The whole
 * ranking is one readable sequence of five `if`s, which is the point — the
 * previous version spread the same decision across a match loop, a dead loop
 * and an "unproven" re-check, and the three could and did disagree.
 */
export function classifySelector(
	selector: SelectorSide,
	sides: ClassifySides,
): SelectorClassification {
	const regex = selector.pattern ? compilePattern(selector.pattern) : null;

	const direct = directMatches(
		selector,
		regex,
		sides.renderedById,
		sides.renderedStatic,
	);
	if (direct.length > 0) {
		return { stage: "A", verdict: "matched", matches: direct };
	}

	const directProp = directMatches(
		selector,
		regex,
		sides.propById,
		sides.propStatic,
	);
	if (directProp.length > 0) {
		return {
			stage: "B",
			verdict: "forwarding-unproven",
			matches: directProp,
			// The only place anything is outranked: a proven-shape hit against an
			// unproven id beats a guessed hit against a proven one, but the guess is
			// still the best alternative reading and is carried along.
			outranked: speculativeMatches(selector, regex, sides.renderedPatterns),
		};
	}

	const speculative = speculativeMatches(
		selector,
		regex,
		sides.renderedPatterns,
	);
	if (speculative.length > 0) {
		return { stage: "C", verdict: "matched", matches: speculative };
	}

	const speculativeProp = speculativeMatches(
		selector,
		regex,
		sides.propPatterns,
	);
	if (speculativeProp.length > 0) {
		return {
			stage: "D",
			verdict: "forwarding-unproven",
			matches: speculativeProp,
			outranked: [],
		};
	}

	const literal = selector.testId ?? selector.pattern?.literalPrefix ?? "";
	if (literal.length >= MIN_CONTAINMENT_LITERAL) {
		const occurrences = sides.unknownRaw.filter((occurrence) =>
			occurrence.value.raw.includes(literal),
		);
		if (occurrences.length > 0) {
			return {
				stage: "E",
				verdict: "dynamic-testid-expression",
				literal,
				occurrences,
			};
		}
	}

	return { stage: "F", verdict: "dead" };
}

/** How a matched group is named in evidence lists: its id, or its pattern. */
export function labelOf(ui: UiTestId): string {
	return ui.id ?? `/${ui.patternSource ?? ""}/`;
}
