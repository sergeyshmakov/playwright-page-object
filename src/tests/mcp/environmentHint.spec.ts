import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../../analysis";
import { environmentHint } from "../../mcp/tools";

/**
 * The one place an engine diagnostic becomes a CLI flag.
 *
 * The engine names no option on purpose — it is consumed by this server, by
 * tests and by anything embedding it later — so every "restart with …" sentence
 * an agent reads is written here, and every one of them has to name a flag the
 * CLI will actually accept.
 */

const scopeIncomplete = (
	data: Record<string, string | number | boolean | null>,
): Diagnostic => ({
	code: "ui-scope-incomplete",
	severity: "warning",
	message: "component tags come from modules outside the scanned sources",
	data,
});

describe("environmentHint — an incomplete UI scope", () => {
	// `validateServerOptions` refuses a `--src-dir` outside `--project-root`, so
	// the obvious reading of "add their directories to the scan" was advice that
	// stops the server from starting. Re-rooting is the flag that works.
	it("recommends re-rooting, by name, and warns off --src-dir", () => {
		const hint = environmentHint([
			scopeIncomplete({ tags: 12, modules: 3, sourceRoot: "/repo" }),
		]);
		expect(hint).toContain("--project-root /repo");
		expect(hint).toContain("--src-dir");
		expect(hint).toMatch(/--src-dir will not work/);
	});

	// Without a directory there is nothing to re-root at: the modules are
	// installed packages or unresolvable, and no flag reaches their sources.
	// Promising one would be the same unfollowable advice in a new spelling.
	it("says nothing when there is no directory to name", () => {
		expect(environmentHint([scopeIncomplete({ tags: 12, modules: 3 })])).toBe(
			undefined,
		);
	});

	// Informational severity is a run with no dead selectors in it — nothing to
	// misread, so nothing worth pushing to the front of every hint.
	it("stays quiet while nothing looks broken", () => {
		expect(
			environmentHint([
				{ ...scopeIncomplete({ sourceRoot: "/repo" }), severity: "info" },
			]),
		).toBe(undefined);
	});

	/**
	 * Its sibling names `--project-root` exactly and pre-empts the wrong flag,
	 * while this one said "re-run assuming forwarding" and named nothing — so the
	 * only advice in the report a reader could not act on was the one whose fix
	 * is a single flag. That it needs a restart is the part a caller cannot guess
	 * and would spend a call discovering.
	 */
	it("names the per-call override for widespread unproven forwarding", () => {
		const hint = environmentHint([
			{
				code: "forwarding-unproven-widespread",
				severity: "info",
				message: "most selectors match only ids written as component props",
				data: { unproven: 13, selectors: 29 },
			},
		]);

		expect(hint).toContain("--assume-forwarded");
		expect(hint).toContain("13 of 29");
		expect(hint).toContain("assumeForwarded: true");
		expect(hint).not.toContain("restart the server");
	});

	// It is last for a reason: an analysis reading the wrong attribute produces a
	// wrong answer, and where to re-root is beside the point until that is fixed.
	it("yields to a diagnosis that invalidates the whole answer", () => {
		const hint = environmentHint([
			{
				code: "attribute-mismatch",
				severity: "warning",
				message: "nothing uses that attribute",
				data: { attribute: "data-testid", candidate: "data-tid" },
			},
			scopeIncomplete({ tags: 12, modules: 3, sourceRoot: "/repo" }),
		]);
		expect(hint).toContain("--attribute data-tid");
		expect(hint).not.toContain("--project-root");
	});
});
