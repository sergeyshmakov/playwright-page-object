import { describe, expect, it } from "vitest";
import { ToolError } from "../../mcp/errors";
import {
	envelopeBytes,
	fail,
	fitBuckets,
	MAX_RESPONSE_BYTES,
	ok,
} from "../../mcp/respond";

/**
 * The envelope's two failure modes, both of which used to hand a caller advice
 * it could not act on: a size cap that named knobs the tool does not have, and
 * an error carrying a candidate list longer than the payload it replaced.
 */

interface Envelope {
	ok: boolean;
	error?: {
		code: string;
		message?: string;
		hint?: string;
		candidates?: string[];
		suggestions?: string[];
		moreCandidates?: number;
		moreSuggestions?: number;
	};
}

function parse(result: { content: Array<{ text: string }> }): Envelope {
	return JSON.parse(result.content[0].text) as Envelope;
}

const oversized = () => ({ blob: "x".repeat(MAX_RESPONSE_BYTES) });

describe("ok", () => {
	it("returns the payload when it fits", () => {
		const envelope = parse(ok({ a: 1 }, { total: 2 })) as {
			ok: boolean;
			data?: unknown;
			meta?: unknown;
		};
		expect(envelope.ok).toBe(true);
		expect(envelope.data).toEqual({ a: 1 });
		expect(envelope.meta).toEqual({ total: 2 });
	});

	// "Re-call with a smaller depth" is not something `list_page_objects` can do.
	it("uses the caller's own shrink advice over the generic one", () => {
		const envelope = parse(
			ok(oversized(), undefined, {
				shrinkHint: "Re-call with a lower `limit` or page with `offset`.",
			}),
		);
		expect(envelope.ok).toBe(false);
		expect(envelope.error?.code).toBe("too_large");
		expect(envelope.error?.hint).toBe(
			"Re-call with a lower `limit` or page with `offset`.",
		);
	});

	it("falls back to generic advice when a tool offers none", () => {
		const envelope = parse(ok(oversized()));
		expect(envelope.error?.code).toBe("too_large");
		expect(envelope.error?.hint).toContain("depth");
	});

	/**
	 * The cap is bytes on the wire, and it was compared against `String.length`.
	 * Those agree only for ASCII: a CJK character is one code unit and three
	 * UTF-8 bytes, so a payload three times the cap used to pass the check that
	 * exists to stop it. This server's job on a real repository is to carry other
	 * people's identifiers, and plenty of them are not ASCII.
	 */
	it("measures the cap in bytes, not UTF-16 code units", () => {
		// Comfortably under the cap by `.length`, comfortably over it by bytes.
		const wide = { blob: "中".repeat(MAX_RESPONSE_BYTES / 2) };
		expect(JSON.stringify(wide).length).toBeLessThan(MAX_RESPONSE_BYTES);

		const envelope = parse(ok(wide));
		expect(envelope.ok).toBe(false);
		expect(envelope.error?.code).toBe("too_large");
		// And the number it reports is the byte count, not the code-unit count.
		expect(envelope.error?.message).toMatch(/Response is \d{6,} bytes/);
	});

	/**
	 * `onDelivered` is the gate that stops the session warning ledger recording
	 * warnings a refused response never carried. Both sides of the cap matter.
	 */
	it("runs onDelivered only when the response actually ships", () => {
		let delivered = 0;
		ok({ a: 1 }, undefined, { onDelivered: () => (delivered += 1) });
		expect(delivered, "a response that shipped").toBe(1);

		ok(oversized(), undefined, { onDelivered: () => (delivered += 1) });
		expect(delivered, "a response refused for being too large").toBe(1);
	});
});

describe("envelopeBytes", () => {
	// The auto-degrade fit sizes a response against the cap, so it has to measure
	// exactly what `ok` will write - including `compactMeta` dropping keys.
	it("measures what ok actually puts on the wire", () => {
		const data = { a: [1, 2, 3] };
		const meta = { total: 3, truncated: false, empty: [] as string[] };
		const wire = ok(data, meta).content[0].text;
		expect(envelopeBytes(data, meta)).toBe(wire.length);
		expect(wire).not.toContain("truncated");
	});
});

describe("fitBuckets", () => {
	const slice = (name: string, entries: unknown[]) => ({ name, entries });
	/** Serialized cost of one entry, plus the comma that joins it. */
	const cost = (entry: unknown) => JSON.stringify(entry).length + 1;

	it("keeps everything when the budget is generous", () => {
		const fit = fitBuckets(10_000, [
			slice("a", ["one", "two"]),
			slice("b", ["three"]),
		]);
		expect([...fit]).toEqual([
			["a", 2],
			["b", 1],
		]);
	});

	it("keeps nothing at all when the reserve has eaten the budget", () => {
		// This is how the genuine `too_large` is reached: nothing is kept, and the
		// envelope helper then refuses the (still oversized) summary-only payload.
		const fit = fitBuckets(-50, [slice("a", ["one"]), slice("b", ["two"])]);
		expect([...fit.values()]).toEqual([0, 0]);
	});

	/**
	 * A single greedy pass in bucket order gives the first list everything and
	 * the last list nothing, which is the wrong answer for a report whose most
	 * useful bucket ships last.
	 */
	it("splits the budget rather than letting the first bucket take it all", () => {
		const many = Array.from({ length: 50 }, (_, i) => `first-${i}`);
		const few = ["second-0", "second-1"];
		const budget = cost(many[0]) * 10 + cost(few[0]) * 2;

		const fit = fitBuckets(budget, [slice("a", many), slice("b", few)]);
		expect(fit.get("b"), "the second list is not starved").toBe(2);
		expect(fit.get("a")).toBeGreaterThan(0);
		expect(fit.get("a")).toBeLessThan(many.length);
	});

	it("hands what one bucket did not spend to the one that was cut", () => {
		const many = Array.from({ length: 40 }, (_, i) => `long-entry-${i}`);
		const budget = cost(many[0]) * 20 + cost("tiny") * 2;

		const shared = fitBuckets(budget, [slice("a", many), slice("b", ["tiny"])]);
		// b needs one entry out of its half; the other half goes back to a, which
		// therefore keeps more than the ten its own share would have paid for.
		expect(shared.get("b")).toBe(1);
		expect(shared.get("a")).toBeGreaterThan(10);
	});

	it("never keeps an entry it cannot pay for", () => {
		const entries = ["x".repeat(500)];
		expect(fitBuckets(100, [slice("a", entries)]).get("a")).toBe(0);
	});
});

describe("fail", () => {
	it("caps candidates and says how many it left out", () => {
		const candidates = Array.from({ length: 25 }, (_, i) => `file${i}.ts`);
		const envelope = parse(
			fail(new ToolError("ambiguous_class", "too many", { candidates })),
		);
		expect(envelope.error?.candidates).toHaveLength(10);
		expect(envelope.error?.moreCandidates).toBe(15);
	});

	it("caps suggestions the same way", () => {
		const suggestions = Array.from({ length: 12 }, (_, i) => `Page${i}`);
		const envelope = parse(
			fail(new ToolError("class_not_found", "nope", { suggestions })),
		);
		expect(envelope.error?.suggestions).toHaveLength(10);
		expect(envelope.error?.moreSuggestions).toBe(2);
	});

	it("says nothing about overflow when there is none", () => {
		const envelope = parse(
			fail(new ToolError("class_not_found", "nope", { suggestions: ["A"] })),
		);
		expect(envelope.error?.suggestions).toEqual(["A"]);
		expect(envelope.error?.moreSuggestions).toBeUndefined();
	});
});
