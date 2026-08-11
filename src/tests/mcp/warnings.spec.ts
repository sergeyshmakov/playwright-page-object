import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../../analysis";
import { planWarnings, WarningLedger } from "../../mcp/warnings";

/**
 * The ledger's whole risk is telling a reader "you have seen this" when they
 * have not, so these tests are mostly about the two ways that can happen: a
 * response that never shipped, and a warning whose text changed.
 */

function warning(
	code: Diagnostic["code"],
	message: string,
	extra: Partial<Diagnostic> = {},
): Diagnostic {
	return { code, severity: "warning", message, ...extra };
}

const scopeEmpty = warning("scope-empty", "No JSX/TSX sources were scanned.");

describe("WarningLedger", () => {
	it("sends a warning in full the first time and by code after that", () => {
		const ledger = new WarningLedger();

		const first = ledger.plan([scopeEmpty]);
		expect(first.shown).toEqual([scopeEmpty]);
		first.delivered();

		const second = ledger.plan([scopeEmpty]);
		expect(second.shown).toEqual([
			{ code: "scope-empty", severity: "warning", repeat: 1 },
		]);
	});

	/**
	 * The reason `delivered` exists at all. `ok` refuses an oversized payload,
	 * and a ledger that had already recorded those warnings would abbreviate, on
	 * the next call, text the reader never received.
	 */
	it("forgets a response that was never delivered", () => {
		const ledger = new WarningLedger();
		ledger.plan([scopeEmpty]); // planned, refused, never delivered
		expect(ledger.size).toBe(0);
		expect(ledger.plan([scopeEmpty]).shown).toEqual([scopeEmpty]);
	});

	it("sends the full text again when the verdict changes", () => {
		const ledger = new WarningLedger();
		const before = warning("attribute-mismatch", "nothing uses data-testid", {
			data: { attribute: "data-testid", candidate: "data-tid" },
		});
		const after = warning("attribute-mismatch", "nothing uses data-testid", {
			data: { attribute: "data-testid", candidate: "data-qa" },
		});

		ledger.plan([before]).delivered();
		// Same code, same message, different candidate: a different answer, so it
		// must not arrive as a bare reminder of the first one.
		expect(ledger.plan([after]).shown).toEqual([after]);
	});

	it("counts repeats of one code instead of repeating empty objects", () => {
		const ledger = new WarningLedger();
		const sites = [1, 2, 3].map((line) =>
			warning("dynamic-selector-arg", `dynamic at line ${line}`, {
				loc: { file: "src/Page.ts", line },
			}),
		);

		ledger.plan(sites).delivered();
		expect(ledger.plan(sites).shown).toEqual([
			{ code: "dynamic-selector-arg", severity: "warning", repeat: 3 },
		]);
	});

	it("keeps a new warning in full alongside repeats of an old one", () => {
		const ledger = new WarningLedger();
		ledger.plan([scopeEmpty]).delivered();

		const fresh = warning("scope-dir-missing", 'no such directory "src/ui"');
		const plan = ledger.plan([scopeEmpty, fresh]);
		// The new one first: a reader scanning the top of the list sees what
		// changed, not what has been true all along.
		expect(plan.shown).toEqual([
			fresh,
			{ code: "scope-empty", severity: "warning", repeat: 1 },
		]);
	});

	it("re-sends in full once a warning falls out of the bounded memory", () => {
		const ledger = new WarningLedger(2);
		ledger.plan([scopeEmpty]).delivered();
		ledger
			.plan([warning("no-tsconfig", "a"), warning("scope-dir-missing", "b")])
			.delivered();

		expect(ledger.size).toBe(2);
		// Evicted, so the safe direction: the text comes back rather than a code
		// the reader may never have been given the meaning of.
		expect(ledger.plan([scopeEmpty]).shown).toEqual([scopeEmpty]);
	});

	it("abbreviates nothing without a ledger", () => {
		const plan = planWarnings(undefined, [scopeEmpty]);
		expect(plan.shown).toEqual([scopeEmpty]);
		expect(() => plan.delivered()).not.toThrow();
	});
});
