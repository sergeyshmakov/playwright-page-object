import { describe, expect, it } from "vitest";
import {
	matchSelectorToUi,
	probesFromPattern,
} from "../../../analysis/coverage/match";
import { editDistance, nearestIds } from "../../../analysis/coverage/suggest";
import type { PatternInfo, UiTestId } from "../../../analysis/types";

const staticUi = (id: string): UiTestId => ({
	id,
	patternSource: null,
	prefix: id,
	occurrences: [],
});

const patternUi = (source: string, prefix: string | null): UiTestId => ({
	id: null,
	patternSource: source,
	patternFlags: "",
	prefix,
	occurrences: [],
});

const fromMask = (mask: string): PatternInfo => ({
	source: mask,
	flags: "",
	origin: "string",
	matchMode: "regexUnanchored",
	literalPrefix: mask,
});

const fromRegex = (source: string, flags = ""): PatternInfo => ({
	source,
	flags,
	origin: "regex",
	matchMode: "regex",
	literalPrefix: null,
});

describe("matchSelectorToUi", () => {
	it("matches an exact id against a static id", () => {
		expect(
			matchSelectorToUi(
				{ testId: "PromoCodeInput" },
				staticUi("PromoCodeInput"),
			),
		).toEqual({ confidence: "exact" });
		expect(
			matchSelectorToUi({ testId: "Other" }, staticUi("PromoCodeInput")),
		).toBeNull();
	});

	it("matches an exact id against a UI pattern", () => {
		expect(
			matchSelectorToUi(
				{ testId: "CartItem_7" },
				patternUi("^CartItem_.+$", "CartItem_"),
			),
		).toEqual({ confidence: "pattern" });
	});

	it("matches a regex-literal selector against a static id", () => {
		expect(
			matchSelectorToUi(
				{ pattern: fromRegex("^Item_\\d+$", "i") },
				staticUi("item_42"),
			),
		).toEqual({ confidence: "regex" });
	});

	it("treats a string mask as unanchored, exactly like `new RegExp(mask)`", () => {
		// `@ListSelector("Item")` really does match `CartItem_1` at runtime.
		expect(
			matchSelectorToUi({ pattern: fromMask("Item") }, staticUi("CartItem_1")),
		).toEqual({ confidence: "regex" });
	});

	it("does not match when the selector regex anchors and the id does not fit", () => {
		expect(
			matchSelectorToUi(
				{ pattern: fromRegex("^Item_\\d+$") },
				staticUi("CartItem_1"),
			),
		).toBeNull();
	});

	it("uses probes to match a mask against a UI pattern", () => {
		const outcome = matchSelectorToUi(
			{ pattern: fromMask("CartItem_") },
			patternUi("^CartItem_.+$", "CartItem_"),
		);
		expect(outcome).toEqual({ confidence: "probe", probe: "CartItem_1" });
	});

	it("falls back to literal-prefix containment when no probe fits", () => {
		// `\d{4}` rejects every probe, but the prefixes still overlap.
		const outcome = matchSelectorToUi(
			{ pattern: fromRegex("^Row_\\d{4}$") },
			patternUi("^Row_.+$", "Row_"),
		);
		expect(outcome).toBeNull();

		const withPrefix = matchSelectorToUi(
			{
				pattern: {
					...fromRegex("^Row_\\d{4}$"),
					literalPrefix: "Row_",
				},
			},
			patternUi("^Row_.+$", "Row_"),
		);
		expect(withPrefix).toEqual({ confidence: "prefix" });
	});

	it("honours the `i` flag in the literal-prefix fallback", () => {
		const insensitive = matchSelectorToUi(
			{
				pattern: {
					...fromRegex("^row_\\d{4}$", "i"),
					literalPrefix: "row_",
				},
			},
			patternUi("^Row_.+$", "Row_"),
		);
		expect(insensitive).toEqual({ confidence: "prefix" });

		const sensitive = matchSelectorToUi(
			{
				pattern: {
					...fromRegex("^row_\\d{4}$"),
					literalPrefix: "row_",
				},
			},
			patternUi("^Row_.+$", "Row_"),
		);
		expect(sensitive).toBeNull();
	});

	it("returns null for an unmatchable selector shape", () => {
		expect(matchSelectorToUi({}, staticUi("X"))).toBeNull();
	});

	it("survives an invalid regex source without throwing", () => {
		expect(
			matchSelectorToUi({ pattern: fromRegex("[") }, staticUi("X")),
		).toBeNull();
	});
});

describe("probesFromPattern", () => {
	it("substitutes each hole with three representative values", () => {
		expect(probesFromPattern(patternUi("^CartItem_.+$", "CartItem_"))).toEqual([
			"CartItem_1",
			"CartItem_abc",
			"CartItem_x-y_0",
		]);
	});

	it("unescapes literal parts so probes are real strings", () => {
		expect(probesFromPattern(patternUi("^item\\..+$", "item."))).toEqual([
			"item.1",
			"item.abc",
			"item.x-y_0",
		]);
	});

	it("returns the literal itself when there are no holes", () => {
		expect(probesFromPattern(patternUi("^Row$", "Row"))).toEqual(["Row"]);
	});

	it("returns nothing for a static id", () => {
		expect(probesFromPattern(staticUi("Row"))).toEqual([]);
	});
});

describe("nearestIds", () => {
	it("suggests a plausible typo", () => {
		expect(nearestIds("PromoCodeInpt", ["PromoCodeInput", "SignIn"])).toEqual([
			"PromoCodeInput",
		]);
	});

	it("refuses to suggest something that is not plausibly a typo", () => {
		expect(nearestIds("PromoCode", ["SignIn", "EmptyCart"])).toEqual([]);
	});

	it("caps the number of suggestions", () => {
		expect(nearestIds("Row", ["Rows", "Rov", "Ro", "Roww"], 2)).toHaveLength(2);
	});

	it("computes distances symmetrically", () => {
		expect(editDistance("kitten", "sitting")).toBe(3);
		expect(editDistance("", "abc")).toBe(3);
		expect(editDistance("same", "same")).toBe(0);
	});
});
