import type { CoverageBucket } from "../../analysis";
import type { ToolMeta } from "../respond";
import {
	envelopeBytes,
	fitBuckets,
	MAX_RESPONSE_BYTES,
	ok,
	type TextResult,
} from "../respond";
import { COVERAGE_BUCKETS } from "../schemas";

/**
 * Which coverage lists ship, how much of each fits, and what to say when the
 * byte cap cut one.
 *
 * Pure over plain data: bucket names, arrays of already-built entries, a byte
 * budget. `respond.ts` owns the measuring (`fitBuckets`, `envelopeBytes`) and
 * was extracted for the same reason; this is the accounting on top of it.
 *
 * The two things worth testing here have never had a direct test, because
 * reaching either through a booted client needs a fixture built to defeat a
 * byte cap: the reserve that `coverageResult` measures before trimming, and the
 * `starved` bucket - the one case `nextOffset` cannot express, whose sentence
 * cost a `too_large` at 99 bytes over when it was left out of that reserve.
 */

/** Bucket names in the order the report ships them. */
export const BUCKET_ORDER: CoverageBucket[] = [...COVERAGE_BUCKETS];

/** Which lists this call asked for, and whether an argument was overruled. */
export function selectedBuckets(
	requested: CoverageBucket[] | undefined,
	includeUnused: boolean,
	/** Whether the caller actually wrote `includeUnused`, rather than defaulting. */
	unusedWasGiven: boolean,
): { buckets: Set<CoverageBucket>; ignored?: string[] } {
	if (requested !== undefined) {
		// Two ways to say the same thing, so one of them has to win, and the
		// explicit list is the one the caller wrote on purpose. Saying which was
		// dropped costs one meta field and saves a debugging session.
		//
		// An empty array is a list too: `buckets: []` asks for summary and scope
		// and nothing else, which is the cheapest possible coverage call. Reading
		// it as "no preference" returned all six lists — the opposite of what the
		// schema promises, at the maximum response size.
		// Only when there was something to overrule. `includeUnused` became
		// optional, and reporting it as ignored on a call that never mentioned it
		// tells the caller an argument of theirs was dropped when none was.
		return {
			buckets: new Set(requested),
			...(unusedWasGiven ? { ignored: ["includeUnused"] } : {}),
		};
	}
	const buckets = new Set(BUCKET_ORDER);
	if (!includeUnused) {
		buckets.delete("uncoveredTestIds");
	}
	return { buckets };
}

/** One list this call means to return: its page, and the size it was cut from. */
export interface BucketSlice {
	name: CoverageBucket;
	total: number;
	page: unknown[];
}

/** What actually shipped, once the byte budget has had its say. */
export interface CoveragePaging {
	shown: Record<string, number>;
	nextOffset: Record<string, number>;
	/** Buckets the size cap cut below the page `limit` had already selected. */
	truncatedBuckets: CoverageBucket[];
	/** Entries remain past what shipped, whether cut by `limit` or by bytes. */
	truncated: boolean;
	/** Entries shipped across every returned bucket. */
	returned: number;
	/** The size cap cut something: `truncatedBuckets` is non-empty. */
	degraded: boolean;
	/**
	 * Buckets that kept no entry at all, so `nextOffset` cannot name them.
	 *
	 * Carried here rather than re-derived from `shown === 0`, which is how
	 * {@link degradeHint} used to find them. The reserve measurement builds the
	 * meta at its widest, and under that rule the two dimensions fight: the
	 * widest `shown` is the page length, which is never zero, so the starvation
	 * sentence was never in the reserve at all - and a page trimmed to the bytes
	 * it allowed came back `too_large` anyway, reproduced at 99 bytes over. As
	 * its own field it can be set to every bucket while the numbers beside it
	 * stay at full width.
	 */
	starved: CoverageBucket[];
}

/**
 * The coverage envelope, shrunk to fit rather than refused.
 *
 * An oversized report used to come back as a `too_large` error carrying advice.
 * That is the one answer an agent cannot use: it has spent a call, learned
 * nothing about the repository, and has to guess which knob to turn. So
 * `summary` and `scope` always ship — they are the totals every capped list is
 * read against — and each requested bucket ships as much of its page as the
 * remaining bytes allow, with `meta.truncatedBuckets` naming what was cut and
 * `meta.nextOffset` saying where to resume.
 *
 * Fitting is measured, never estimated, and never quadratic (see
 * {@link fitBuckets}). The reserve is measured first, with the meta at its
 * widest — every bucket named as truncated, every `nextOffset` at its largest
 * possible value, the longest hint — because `compactMeta` only ever removes
 * keys, so the real meta cannot exceed the one measured here.
 *
 * If even that reserve is over the cap, nothing is kept, `ok` refuses the
 * result, and the caller gets the genuine `too_large` with this tool's own
 * shrink advice. That case falls out of the arithmetic rather than needing its
 * own branch.
 */
export function coverageResult(input: {
	base: Record<string, unknown>;
	slices: BucketSlice[];
	offset: number;
	buildMeta: (paging: CoveragePaging) => ToolMeta;
	shrinkHint: string;
	onDelivered?: () => void;
}): TextResult {
	const { base, slices, offset, buildMeta, shrinkHint, onDelivered } = input;

	const pagingFor = (kept: number[]): CoveragePaging => {
		const shown: Record<string, number> = {};
		const nextOffset: Record<string, number> = {};
		const truncatedBuckets: CoverageBucket[] = [];
		const starved: CoverageBucket[] = [];
		let truncated = false;
		let returned = 0;
		slices.forEach((slice, index) => {
			const count = kept[index];
			const end = offset + count;
			returned += count;
			if (end < slice.total) {
				truncated = true;
				// Only when it is forward progress. A bucket whose first entry does
				// not fit keeps `end === offset`, and echoing that back as the next
				// page is an invitation to loop on the same call forever; the hint
				// says what to do instead.
				if (end > offset) {
					nextOffset[slice.name] = end;
				}
			}
			// Only when the page is not the whole bucket: on a complete list the
			// count is the array's own length and saying it again is noise.
			if (count !== slice.total) {
				shown[slice.name] = count;
			}
			if (count < slice.page.length) {
				truncatedBuckets.push(slice.name);
			}
			if (count === 0 && slice.page.length > 0) {
				starved.push(slice.name);
			}
		});
		return {
			shown,
			nextOffset,
			truncatedBuckets,
			truncated,
			returned,
			degraded: truncatedBuckets.length > 0,
			starved,
		};
	};

	const dataFor = (kept: number[]): Record<string, unknown> => {
		const data: Record<string, unknown> = { ...base };
		slices.forEach((slice, index) => {
			data[slice.name] =
				kept[index] === slice.page.length
					? slice.page
					: slice.page.slice(0, kept[index]);
		});
		return data;
	};

	// The ordinary answer, measured once. Everything that already fits takes this
	// path and is byte-identical to what it was before auto-degrade existed.
	const whole = slices.map((slice) => slice.page.length);
	const wholeData = dataFor(whole);
	const wholeMeta = buildMeta(pagingFor(whole));
	if (envelopeBytes(wholeData, wholeMeta) <= MAX_RESPONSE_BYTES) {
		return ok(wholeData, wholeMeta, { shrinkHint, onDelivered });
	}

	const widestMeta = buildMeta({
		shown: Object.fromEntries(
			slices.map((slice) => [slice.name, slice.page.length]),
		),
		nextOffset: Object.fromEntries(
			slices.map((slice) => [slice.name, offset + slice.page.length]),
		),
		truncatedBuckets: slices.map((slice) => slice.name),
		truncated: true,
		returned: 0,
		degraded: true,
		// Every bucket, so the starvation sentence is measured at full length.
		starved: slices
			.filter((slice) => slice.page.length > 0)
			.map((slice) => slice.name),
	});
	const reserve = envelopeBytes(dataFor(slices.map(() => 0)), widestMeta);
	const fit = fitBuckets(
		MAX_RESPONSE_BYTES - reserve,
		slices.map((slice) => ({ name: slice.name, entries: slice.page })),
	);
	const kept = slices.map((slice) => fit.get(slice.name) ?? 0);
	return ok(dataFor(kept), buildMeta(pagingFor(kept)), {
		shrinkHint,
		onDelivered,
	});
}

/**
 * What to say when the size cap cut the page down.
 *
 * Names the lists that lost entries and the exact next call, because the value
 * of degrading over erroring is only realised if the caller knows how to
 * continue. A bucket that lost *everything* is the one case `nextOffset` cannot
 * express, so it gets its own sentence.
 */
export function degradeHint(
	paging: CoveragePaging,
	coverageId: string | undefined,
): string | undefined {
	if (!paging.degraded) {
		return undefined;
	}
	const starved = paging.starved;
	const cut = paging.truncatedBuckets;
	// The worked example resumes a bucket that actually has a next page; a
	// starved one has no offset to name and gets its own sentence instead.
	const resumable = cut.find((name) => paging.nextOffset[name] !== undefined);
	const resume =
		coverageId && resumable
			? `query_coverage {"coverageId":"${coverageId}","bucket":"${resumable}","offset":${paging.nextOffset[resumable]}}`
			: "a lower `limit`, then `offset`";
	const starvation =
		starved.length > 0
			? ` ${starved.join(", ")} held no entry small enough for the bytes left over; request that bucket on its own so it gets the whole budget.`
			: "";
	return `This page would have exceeded the ${MAX_RESPONSE_BYTES}-byte response cap, so ${cut.join(", ")} ${cut.length > 1 ? "were" : "was"} cut to fit instead of the call failing - summary still reports every bucket's real size. Continue with ${resume}.${starvation}`;
}

/**
 * What to say about an empty page.
 *
 * An offset past the end returns `[]` for every bucket, which reads exactly
 * like "there is nothing here" — the same confusion `list_page_objects` had,
 * and the reason it reports the end of its list rather than an empty one.
 */
export function pagingHint(
	offset: number,
	requested: number,
	returned: number,
	largest: number,
): string | undefined {
	if (offset === 0 || requested === 0 || returned > 0) {
		return undefined;
	}
	return largest === 0
		? `Every requested bucket is empty, so offset ${offset} returned nothing; the buckets themselves hold no entries.`
		: `offset ${offset} is past the end of every requested bucket (the largest holds ${largest}); re-call with a smaller offset.`;
}

/**
 * What to change to make THIS coverage call fit.
 *
 * The generic advice named `includeUnused`, which `selectedBuckets` ignores
 * whenever `buckets` is set. A caller who had already narrowed to one bucket
 * was told to pass a no-op, re-called, and got a byte-identical error - the
 * one shape of hint that costs a call and teaches nothing. So the advice now
 * depends on which knobs are still live.
 */
export function coverageShrinkHint(
	buckets: CoverageBucket[] | undefined,
	limit: number,
	coverageId?: string,
): string {
	const lowerLimit = `a lower \`limit\` (this call used ${limit})`;
	// Only reachable when even `summary` + `scope` overflow, since a bucket page
	// is now trimmed to fit rather than refused - but that is exactly the call
	// where naming a handle nobody can spend would be noise.
	const handle = coverageId
		? ` Or page one bucket at a time with query_coverage {"coverageId":"${coverageId}", ...}.`
		: "";

	if (buckets === undefined) {
		return `Re-call with ${lowerLimit}, \`buckets\` naming only the lists you need, or includeUnused:false. \`buckets: []\` returns summary and scope alone, which always fits.${handle}`;
	}
	if (buckets.length === 0) {
		// Nothing the caller passes can shrink this one: `summary` and `scope` are
		// the envelope, and they ship whatever `limit` and `buckets` say. The
		// advice above would send them to re-send the call they just sent — the
		// same loop the one-bucket case below was written to end, one step
		// further in.
		// No handle clause here, unlike every other branch. `query_coverage` ships
		// `{ summary, scope }` at offset 0 — the same envelope that just
		// overflowed — so its first page fails `too_large` identically, and
		// offering it would contradict the sentence it is appended to.
		return `This response is summary and scope alone, so neither \`limit\` nor \`buckets\` can make it smaller - the scope block itself is over the cap. Narrow what the server scans (--src-dir) or analyse one package at a time.`;
	}
	if (buckets.length > 1) {
		return `Re-call with ${lowerLimit}, or fewer \`buckets\` - one at a time pages cleanly through \`offset\`. (\`includeUnused\` is ignored while \`buckets\` is set.)${handle}`;
	}
	// One bucket already, so the only lever left is the page size. Naming
	// `buckets` again here is what produced the loop.
	return `Re-call with ${lowerLimit}, then page the rest with \`offset\`. \`buckets: []\` returns summary and scope alone if you only need the totals.${handle}`;
}
