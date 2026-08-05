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

	// Last resort: literal-prefix containment in either direction. Catches
	// patterns whose holes the probes could not satisfy (digits-only, say).
	const selectorPrefix = selector.pattern.literalPrefix;
	const uiPrefix = ui.prefix ?? null;
	if (
		selectorPrefix &&
		uiPrefix &&
		(uiPrefix.includes(selectorPrefix) || selectorPrefix.includes(uiPrefix))
	) {
		return { confidence: "prefix" };
	}
	return null;
}
