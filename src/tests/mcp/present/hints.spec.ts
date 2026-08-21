import { describe, expect, it } from "vitest";
import { listEmptyHint, lookupHint } from "../../../mcp/present/hints";

/**
 * What a lookup says beyond the occurrence list.
 *
 * These are the sentences an agent acts on when the answer is empty, so a wrong
 * one costs a whole extra call — which is the entire cost of an empty lookup in
 * the first place.
 */

describe("the concrete id a family hint names", () => {
	/**
	 * `${needle}_0` only exists when the separator happens to be `_` and the
	 * needle is the whole prefix. For `Row-${i}`, or for a partial needle, it
	 * named an id nothing renders and sent the reader on a second empty lookup.
	 */
	it("builds the example from the family, not the needle", () => {
		const hint = lookupHint("Row", 0, 0, false, ["Row-*"]);
		expect(hint).toContain('"Row-0"');
		expect(hint).not.toContain('"Row_0"');
	});

	it("handles a needle shorter than the prefix", () => {
		const hint = lookupHint("Ro", 0, 0, false, ["Row_*"]);
		expect(hint).toContain('"Row_0"');
	});

	it("still says plainly when nothing renders the id at all", () => {
		const hint = lookupHint("Nope", 0, 0, false, []);
		expect(hint).toContain("No rendered element");
		expect(hint).not.toContain("id family");
	});
});

describe("an empty page-object index", () => {
	it("does not rule out candidates that the bounded config probe omitted", () => {
		const hint = listEmptyHint(undefined, 0, 0, [], {
			tsconfig: "tsconfig.json",
			scanned: 1,
			candidates: [],
			candidatesTruncated: true,
		});

		expect(hint).toContain("completed portion");
		expect(hint).toContain("Additional tsconfigs or source files were omitted");
		expect(hint).not.toContain("No other tsconfig under the project root");
	});
});
