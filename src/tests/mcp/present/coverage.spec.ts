import { describe, expect, it } from "vitest";
import type { CoverageBucket } from "../../../analysis";
import {
	type BucketSlice,
	type CoveragePaging,
	coverageResult,
	coverageShrinkHint,
	degradeHint,
	pagingHint,
	selectedBuckets,
} from "../../../mcp/present/coverage";
import { MAX_RESPONSE_BYTES } from "../../../mcp/respond";

/**
 * Which coverage lists ship, how much of each fits, and what is said when the
 * byte cap cut one.
 *
 * The two pieces worth testing here had never been tested directly, because
 * reaching either through a booted client needs a repository built to defeat a
 * 200 KB cap — the existing fixture pads each of 300 members to 1,170
 * characters purely so a full page overflows, which makes the *fixture
 * geometry* load-bearing: retune the cap and you retune the multiplier.
 *
 * `starved` in particular was asserted nowhere, despite carrying a comment
 * about a failure reproduced at 99 bytes over the cap.
 */

/** An entry whose serialized size is close to `bytes`. */
function entry(bytes: number): string {
	return "x".repeat(Math.max(bytes - 2, 1));
}

function slice(
	name: CoverageBucket,
	page: unknown[],
	total = page.length,
): BucketSlice {
	return { name, total, page };
}

const paging = (overrides: Partial<CoveragePaging> = {}): CoveragePaging => ({
	shown: {},
	nextOffset: {},
	truncatedBuckets: [],
	truncated: false,
	returned: 0,
	degraded: false,
	starved: [],
	...overrides,
});

describe("selectedBuckets", () => {
	it("returns everything but uncoveredTestIds by default", () => {
		const { buckets, ignored } = selectedBuckets(undefined, false, false);
		expect(buckets.has("matched")).toBe(true);
		expect(buckets.has("uncoveredTestIds")).toBe(false);
		expect(ignored).toBeUndefined();
	});

	it("includes uncoveredTestIds when asked", () => {
		expect(
			selectedBuckets(undefined, true, true).buckets.has("uncoveredTestIds"),
		).toBe(true);
	});

	it("lets an explicit list win, and says the other argument was ignored", () => {
		// Two ways to say the same thing, so one has to win; the explicit list is
		// the one the caller wrote on purpose. Saying which lost is the point -
		// silently dropping an argument is how a caller stops trusting the tool.
		const { buckets, ignored } = selectedBuckets(["matched"], true, true);
		expect([...buckets]).toEqual(["matched"]);
		expect(ignored).toContain("includeUnused");
	});

	it("does not report an ignored argument the caller never wrote", () => {
		expect(selectedBuckets(["matched"], false, false).ignored).toBeUndefined();
	});

	it("honours an empty list as a real request for just the summary", () => {
		expect([...selectedBuckets([], false, false).buckets]).toEqual([]);
	});
});

describe("coverageResult", () => {
	const build = (slices: BucketSlice[], offset = 0) => {
		let seen: CoveragePaging | undefined;
		const result = coverageResult({
			base: { summary: { matched: 1 } },
			slices,
			offset,
			buildMeta: (p) => {
				seen = p;
				return {};
			},
			shrinkHint: "narrow it",
		});
		const text = result.content[0].text;
		return { paging: seen as CoveragePaging, text, bytes: text.length };
	};

	it("ships everything when everything fits", () => {
		const { paging: p, bytes } = build([slice("matched", ["a", "b", "c"])]);
		expect(bytes).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
		expect(p.degraded).toBe(false);
		expect(p.truncated).toBe(false);
		expect(p.returned).toBe(3);
		// A complete list says its own length; repeating it is noise.
		expect(p.shown.matched).toBeUndefined();
	});

	it("reports a page cut by `limit` as truncated but not degraded", () => {
		// `truncated` means "entries remain", however they were cut; `degraded`
		// means the *byte cap* did the cutting. Conflating them told a caller to
		// narrow a call that was already the size they asked for.
		const { paging: p } = build([slice("matched", ["a", "b"], 10)]);
		expect(p.truncated).toBe(true);
		expect(p.degraded).toBe(false);
		expect(p.nextOffset.matched).toBe(2);
	});

	it("trims to fit instead of refusing, and stays under the cap", () => {
		const fat = Array.from({ length: 400 }, () => entry(1000));
		const { paging: p, bytes } = build([slice("matched", fat)]);
		expect(bytes).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
		expect(p.degraded).toBe(true);
		expect(p.truncatedBuckets).toEqual(["matched"]);
		expect(p.shown.matched).toBeGreaterThan(0);
		expect(p.shown.matched).toBeLessThan(400);
	});

	it("stays under the cap when a bucket is starved outright", () => {
		// The case `nextOffset` cannot express, and the one whose sentence was
		// left out of the reserve - measured at 99 bytes over the cap. One entry
		// too wide to fit beside a bucket that has already spent the budget.
		//
		// What this does *not* pin, said plainly: the reserve arithmetic itself.
		// Reverting the fix that puts the starvation sentence into the widest
		// meta leaves this green, because that reserve carries other slack - every
		// `shown` and `nextOffset` measured at maximum width - which happens to be
		// wider than the sentence. Reproducing the 99-byte overflow needs the
		// total to land inside that slack, and a fixture pinned that finely tests
		// the fixture. What is covered here is `starved` being populated at all,
		// which nothing asserted before.
		const fat = Array.from({ length: 400 }, () => entry(1000));
		const { paging: p, bytes } = build([
			slice("matched", fat),
			slice("deadSelectors", [entry(MAX_RESPONSE_BYTES)]),
		]);
		expect(bytes).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
		expect(p.starved).toContain("deadSelectors");
		// Starved, so there is no forward progress to name.
		expect(p.nextOffset.deadSelectors).toBeUndefined();
	});

	it("offsets nextOffset from where the page started", () => {
		const { paging: p } = build([slice("matched", ["a", "b"], 50)], 20);
		expect(p.nextOffset.matched).toBe(22);
	});
});

describe("degradeHint", () => {
	it("says nothing when nothing was cut by bytes", () => {
		expect(degradeHint(paging(), "cov_1")).toBeUndefined();
	});

	it("names the cut buckets and a worked next call", () => {
		const hint = degradeHint(
			paging({
				degraded: true,
				truncatedBuckets: ["matched"],
				nextOffset: { matched: 12 },
				shown: { matched: 12 },
			}),
			"cov_abc",
		);
		expect(hint).toContain("matched");
		expect(hint).toContain('query_coverage {"coverageId":"cov_abc"');
		expect(hint).toContain('"offset":12');
	});

	it("falls back to generic advice with no handle to page with", () => {
		const hint = degradeHint(
			paging({
				degraded: true,
				truncatedBuckets: ["matched"],
				nextOffset: { matched: 12 },
			}),
			undefined,
		);
		expect(hint).toContain("lower `limit`");
		expect(hint).not.toContain("query_coverage {");
	});

	it("gives a starved bucket its own sentence, since offset cannot express it", () => {
		const hint = degradeHint(
			paging({
				degraded: true,
				truncatedBuckets: ["matched", "deadSelectors"],
				nextOffset: { matched: 5 },
				starved: ["deadSelectors"],
			}),
			"cov_abc",
		);
		expect(hint).toContain("deadSelectors held no entry small enough");
		expect(hint).toContain("on its own");
	});
});

describe("pagingHint", () => {
	it("says nothing on a first page, or when something came back", () => {
		expect(pagingHint(0, 50, 0, 10)).toBeUndefined();
		expect(pagingHint(20, 50, 5, 10)).toBeUndefined();
		expect(pagingHint(20, 0, 0, 10)).toBeUndefined();
	});

	it("explains an empty page past the end of the list", () => {
		const hint = pagingHint(200, 50, 0, 120);
		expect(hint).toBeDefined();
		expect(hint).toContain("120");
	});
});

describe("what to advise when even summary and scope overflow", () => {
	/**
	 * `buckets: []` is the smallest response this tool can produce. Telling that
	 * caller to lower `limit` or pass `buckets: []` is advice to re-send the call
	 * they just sent - the same loop the one-bucket branch was written to end,
	 * one step further in.
	 */
	it("does not send a summary-only caller round again", () => {
		const hint = coverageShrinkHint([], 50);
		expect(hint).not.toContain("`buckets: []`");
		expect(hint).toContain("--src-dir");
	});

	it("still offers the live knobs when buckets are in play", () => {
		expect(coverageShrinkHint(["matched", "deadSelectors"], 50)).toContain(
			"fewer `buckets`",
		);
		expect(coverageShrinkHint(undefined, 50)).toContain("`buckets: []`");
	});
});
