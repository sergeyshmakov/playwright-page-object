import { describe, expect, it } from "vitest";
import { ToolError } from "../../mcp/errors";
import { fail, MAX_RESPONSE_BYTES, ok } from "../../mcp/respond";

/**
 * The envelope's two failure modes, both of which used to hand a caller advice
 * it could not act on: a size cap that named knobs the tool does not have, and
 * an error carrying a candidate list longer than the payload it replaced.
 */

interface Envelope {
	ok: boolean;
	error?: {
		code: string;
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
