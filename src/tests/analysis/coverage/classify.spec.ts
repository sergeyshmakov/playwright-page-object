import { describe, expect, it } from "vitest";
import {
	type ClassifySides,
	classifySelector,
	indexSide,
} from "../../../analysis/coverage/classify";
import type {
	PatternInfo,
	TestIdOccurrence,
	UiTestId,
} from "../../../analysis/types";

/**
 * The ladder, tested in isolation from the workspace.
 *
 * Every rung exists because a real report got one of them wrong: unproven prop
 * ids counted as matches, ids the same report listed as unreadable declared
 * dead, and a speculative pattern hit silently deleted when a stronger piece of
 * evidence won. Order is the whole contract, so the order is what is asserted.
 */

const occurrence = (
	overrides: Partial<TestIdOccurrence> = {},
): TestIdOccurrence => ({
	value: { kind: "static", value: "X", raw: '"X"' },
	file: "src/App.tsx",
	loc: { file: "src/App.tsx", line: 1 },
	tag: "div",
	component: "App",
	reach: "element",
	...overrides,
});

const staticUi = (id: string): UiTestId => ({
	id,
	patternSource: null,
	prefix: id,
	occurrences: [occurrence({ value: { kind: "static", value: id, raw: id } })],
});

const patternUi = (source: string, prefix: string | null): UiTestId => ({
	id: null,
	patternSource: source,
	patternFlags: "",
	prefix,
	occurrences: [occurrence()],
});

const dynamicOccurrence = (raw: string): TestIdOccurrence =>
	occurrence({
		value: { kind: "dynamic", raw, reason: "computed-expression" },
	});

const mask = (source: string): PatternInfo => ({
	source,
	flags: "",
	origin: "string",
	matchMode: "regexUnanchored",
	literalPrefix: source,
});

function sides(input: {
	rendered?: UiTestId[];
	prop?: UiTestId[];
	unknownRaw?: TestIdOccurrence[];
	uiEvidence?: boolean;
}): ClassifySides {
	const rendered = indexSide(input.rendered ?? []);
	const prop = indexSide(input.prop ?? []);
	return {
		renderedById: rendered.byId,
		renderedStatic: rendered.statics,
		renderedPatterns: rendered.patterns,
		propById: prop.byId,
		propStatic: prop.statics,
		propPatterns: prop.patterns,
		unknownRaw: input.unknownRaw ?? [],
		// The ladder's own tests are about ranking evidence, so evidence exists
		// unless a test is specifically about a scan that found none.
		uiEvidence: input.uiEvidence ?? true,
	};
}

describe("classifySelector — the evidence ladder", () => {
	it("A: an exact hit on a rendered id beats everything else on offer", () => {
		const result = classifySelector(
			{ testId: "Row_1" },
			sides({
				rendered: [staticUi("Row_1"), patternUi("^Row_.+$", "Row_")],
				prop: [staticUi("Row_1")],
			}),
		);
		expect(result.stage).toBe("A");
		expect(result.verdict).toBe("matched");
	});

	it("B: an exact hit on an unproven prop outranks a speculative rendered one", () => {
		const result = classifySelector(
			{ testId: "Row_1" },
			sides({
				rendered: [patternUi("^Row_.+$", "Row_")],
				prop: [staticUi("Row_1")],
			}),
		);
		expect(result.stage).toBe("B");
		expect(result.verdict).toBe("forwarding-unproven");
	});

	// Loss-free: the weaker reading is reported, not deleted. Without this the
	// pattern id silently loses its only claimant and reads as untested.
	it("carries the outranked speculative match instead of dropping it", () => {
		const result = classifySelector(
			{ testId: "Row_1" },
			sides({
				rendered: [patternUi("^Row_.+$", "Row_")],
				prop: [staticUi("Row_1")],
			}),
		);
		if (result.stage !== "B") {
			throw new Error("expected stage B");
		}
		expect(result.outranked.map((match) => match.ui.patternSource)).toEqual([
			"^Row_.+$",
		]);
	});

	it("C: a pattern reconciled by probing is a match when nothing stronger fits", () => {
		const result = classifySelector(
			{ testId: "Row_1" },
			sides({ rendered: [patternUi("^Row_.+$", "Row_")] }),
		);
		expect(result).toMatchObject({ stage: "C", verdict: "matched" });
		if (result.stage !== "C") {
			throw new Error("expected stage C");
		}
		expect(result.matches[0].outcome.confidence).toBe("pattern");
	});

	it("D: the same reasoning against a prop id stays unproven", () => {
		const result = classifySelector(
			{ testId: "Row_1" },
			sides({ prop: [patternUi("^Row_.+$", "Row_")] }),
		);
		expect(result).toMatchObject({
			stage: "D",
			verdict: "forwarding-unproven",
		});
		if (result.stage !== "D") {
			throw new Error("expected stage D");
		}
		expect(result.outranked).toEqual([]);
	});

	// The report used to list an id under `unknownTestIds` and simultaneously
	// call the selector for it dead — two contradictory claims in one payload.
	it("E: a literal found inside a runtime-built id is not dead", () => {
		const result = classifySelector(
			{ testId: "RoomsCategoryItem" },
			sides({
				unknownRaw: [dynamicOccurrence("formatTID(RoomsCategoryItem, index)")],
			}),
		);
		expect(result).toMatchObject({
			stage: "E",
			verdict: "dynamic-testid-expression",
			literal: "RoomsCategoryItem",
		});
	});

	it("does not run containment on a literal too short to mean anything", () => {
		const result = classifySelector(
			{ testId: "id" },
			sides({ unknownRaw: [dynamicOccurrence("buildId(prefix)")] }),
		);
		expect(result.stage).toBe("F");
	});

	it("F: only after all five is a selector dead", () => {
		const result = classifySelector(
			{ testId: "Nowhere" },
			sides({
				rendered: [staticUi("Row_1"), patternUi("^Cart_.+$", "Cart_")],
				prop: [staticUi("Ghost")],
				unknownRaw: [dynamicOccurrence("buildId(prefix)")],
			}),
		);
		expect(result).toMatchObject({ stage: "F", verdict: "dead" });
	});

	// The same F rung, and the difference is the whole report: "dead" is a claim
	// about the ids the app renders, and a blind scan has no such set.
	it("F: says unverifiable, not dead, when the scan found no test id at all", () => {
		const result = classifySelector(
			{ testId: "Nowhere" },
			sides({ uiEvidence: false }),
		);
		expect(result).toMatchObject({ stage: "F", verdict: "no-ui-evidence" });
	});

	// One unreadable id must not switch dead detection off for the whole
	// repository — that is the catch-all failure in the other direction.
	it("still says dead when the scan found ids it merely could not use", () => {
		const result = classifySelector(
			{ testId: "Nowhere" },
			sides({ unknownRaw: [dynamicOccurrence("buildId(prefix)")] }),
		);
		expect(result).toMatchObject({ stage: "F", verdict: "dead" });
	});

	it("returns every rendered id one pattern selector covers", () => {
		const result = classifySelector(
			{ pattern: mask("Row_") },
			sides({ rendered: [staticUi("Row_1"), staticUi("Row_2")] }),
		);
		if (result.stage !== "A") {
			throw new Error("expected stage A");
		}
		expect(result.matches.map((match) => match.ui.id)).toEqual([
			"Row_1",
			"Row_2",
		]);
	});

	// A `g` flag makes `RegExp.test` stateful through `lastIndex`, so a regex
	// compiled once per selector would match every other id and no more.
	it("is not fooled by a global flag on the selector pattern", () => {
		const result = classifySelector(
			{ pattern: { ...mask("Row_"), flags: "g" } },
			sides({
				rendered: [staticUi("Row_1"), staticUi("Row_2"), staticUi("Row_3")],
			}),
		);
		if (result.stage !== "A") {
			throw new Error("expected stage A");
		}
		expect(result.matches).toHaveLength(3);
	});

	it("keeps a catch-all pattern out of the indexed pool entirely", () => {
		const indexed = indexSide([patternUi("^.+$", null)]);
		expect(indexed.patterns).toEqual([]);
		expect(
			classifySelector(
				{ testId: "Anything" },
				sides({ rendered: [patternUi("^.+$", null)] }),
			),
		).toMatchObject({ stage: "F" });
	});
});
