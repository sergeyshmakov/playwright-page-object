import type { MatchConfidence, PatternInfo, UiTestId } from "../types";

export interface SelectorSide {
	testId?: string;
	pattern?: PatternInfo;
}

export interface MatchOutcome {
	confidence: MatchConfidence;
	probe?: string;
}

/**
 * Concrete strings standing in for a UI pattern's `${…}` holes.
 *
 * This is the trick that avoids needing regex *intersection*: substitute a few
 * representative values and test the selector regex against them. Deterministic,
 * cheap, and explainable — the winning probe is reported so a reader can verify
 * the reasoning instead of trusting it.
 */
export const PROBE_SUBSTITUTIONS = ["1", "abc", "x-y_0"];

/**
 * Whether a test-id pattern matches literally every id.
 *
 * `data-testid={id}` on one element compiles to the pattern `^.+$`. Matched
 * like any other pattern it "covers" every selector in the repository — in one
 * field test a single such element fabricated matches for about 1340 selectors
 * and emptied the dead-selector list, turning the report from a tool into a
 * source of false confidence.
 *
 * The test is deliberately syntactic: strip the anchors, delete every `.+` and
 * `.*` hole, and a pattern is a catch-all exactly when nothing is left. What
 * remains has to be a literal the id must contain, so `^Cart_.+$` keeps `Cart_`
 * and stays a real pattern, and `^\..+$` keeps the escaped dot and does too.
 */
export function isCatchAllPattern(source: string): boolean {
	const body = source.replace(/^\^/, "").replace(/\$$/, "");
	return body.replace(/\.[+*]/g, "") === "";
}

/** A UI test id whose pattern matches everything, so it can prove nothing. */
export function isCatchAllUi(ui: UiTestId): boolean {
	return ui.patternSource !== null && isCatchAllPattern(ui.patternSource);
}

export function probesFromPattern(ui: UiTestId): string[] {
	const source = ui.patternSource;
	if (!source) {
		return [];
	}
	// `^CartItem_.+$` -> split on the `.+` holes and rebuild with each probe.
	const body = source.replace(/^\^/, "").replace(/\$$/, "");
	const segments = body.split(".+");
	if (segments.length === 1) {
		return [unescapeRegex(body)];
	}
	return PROBE_SUBSTITUTIONS.map((substitution) =>
		segments.map(unescapeRegex).join(substitution),
	);
}

function unescapeRegex(source: string): string {
	return source.replace(/\\([.*+?^${}()|[\]\\/-])/g, "$1");
}

function selectorRegex(pattern: PatternInfo): RegExp | null {
	try {
		return new RegExp(pattern.source, pattern.flags);
	} catch {
		return null;
	}
}

function uiRegex(ui: UiTestId): RegExp | null {
	if (!ui.patternSource) {
		return null;
	}
	try {
		return new RegExp(ui.patternSource, ui.patternFlags ?? "");
	} catch {
		return null;
	}
}

/**
 * Decides whether one selector covers one UI test id.
 *
 * Six rules, in decreasing confidence. Nothing here anchors a string mask:
 * `@ListSelector("CartItem_")` becomes `new RegExp("CartItem_")` at runtime, so
 * treating it as a prefix would silently mis-classify `@ListSelector("Item")`
 * against a UI id of `CartItem_1`.
 */
export function matchSelectorToUi(
	selector: SelectorSide,
	ui: UiTestId,
): MatchOutcome | null {
	// Second line of defence. The pipeline quarantines catch-alls before they
	// reach here, but this function is exported and called from three other
	// places, and every one of them would otherwise "match" everything.
	if (isCatchAllUi(ui)) {
		return null;
	}
	if (selector.testId !== undefined) {
		if (ui.id !== null && ui.id === selector.testId) {
			return { confidence: "exact" };
		}
		const pattern = uiRegex(ui);
		if (pattern?.test(selector.testId)) {
			return { confidence: "pattern" };
		}
		return null;
	}

	if (!selector.pattern) {
		return null;
	}
	const regex = selectorRegex(selector.pattern);
	if (!regex) {
		return null;
	}

	if (ui.id !== null) {
		return regex.test(ui.id) ? { confidence: "regex" } : null;
	}

	for (const probe of probesFromPattern(ui)) {
		if (regex.test(probe)) {
			return { confidence: "probe", probe };
		}
	}

	return prefixOverlap(selector.pattern, ui) ? { confidence: "prefix" } : null;
}

/**
 * Literal-prefix compatibility — the last resort, once the probes have failed.
 *
 * Catches patterns whose holes the probes could not satisfy (digits-only, say).
 * The prefixes are stripped of their regex flags, so an `i` on either side has
 * to be re-applied here or `/cartitem_/i` misses `CartItem_1`.
 *
 * How the two prefixes are compared depends on whether both sides are anchored
 * at the start, because that is what decides whether a string satisfying both
 * can exist at all. Anchored, every matching string *begins* with the prefix,
 * so one prefix has to begin with the other. Containment anywhere is the wrong
 * test there: `/^Item_\d{4}$/` against a rendered `` `CartItem_${id}` `` passed
 * on `"CartItem_".includes("Item_")` while no string satisfies both regexes,
 * and the fabricated match then took a genuinely dead selector out of
 * `deadSelectors` and a genuinely unrendered id out of `uncoveredTestIds`.
 *
 * An unanchored selector really can match in the middle of an id, so
 * containment stays the right test for it.
 */
export function prefixOverlap(pattern: PatternInfo, ui: UiTestId): boolean {
	const insensitive =
		(pattern.flags ?? "").includes("i") ||
		(ui.patternFlags ?? "").includes("i");
	const fold = (value: string) => (insensitive ? value.toLowerCase() : value);
	const selectorPrefix = pattern.literalPrefix;
	const uiPrefix = ui.prefix ?? null;
	if (
		selectorPrefix === null ||
		selectorPrefix === "" ||
		uiPrefix === null ||
		uiPrefix === ""
	) {
		return false;
	}
	const selector = fold(selectorPrefix);
	const rendered = fold(uiPrefix);
	const bothAnchored =
		pattern.source.startsWith("^") && (ui.patternSource ?? "").startsWith("^");
	return bothAnchored
		? rendered.startsWith(selector) || selector.startsWith(rendered)
		: rendered.includes(selector) || selector.includes(rendered);
}
