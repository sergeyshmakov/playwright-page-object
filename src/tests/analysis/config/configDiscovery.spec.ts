import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	CONFIG_GLOB,
	MAX_CONFIG_CANDIDATES,
	rankConfigCandidates,
} from "../../../analysis/config/configDiscovery";
import { toPosix } from "../../../analysis/util/paths";

/**
 * Ranking is pure, so it is tested without a filesystem. Which config a
 * repository ends up analysed with is decided entirely here — `readPlaywrightConfig`
 * takes the first entry — so the order is a contract, not a detail.
 */

const ROOT = path.resolve("/ppo-rank");
const ROOT_POSIX = toPosix(ROOT);

/** Ranks workspace-relative paths and hands back workspace-relative paths. */
function rank(...relatives: string[]): string[] {
	const ranked = rankConfigCandidates(
		ROOT,
		relatives.map((relative) => `${ROOT_POSIX}/${relative}`),
	);
	return ranked.map((absolute) => absolute.slice(ROOT_POSIX.length + 1));
}

describe("CONFIG_GLOB", () => {
	it("covers every extension Playwright accepts", () => {
		expect(CONFIG_GLOB).toBe("**/playwright*.config.{ts,mts,cts,js,mjs,cjs}");
	});
});

describe("rankConfigCandidates", () => {
	it("puts the canonical basename first, however deep it sits", () => {
		expect(
			rank("playwright.base.config.ts", "tools/e2e/playwright.config.ts"),
		).toEqual(["tools/e2e/playwright.config.ts", "playwright.base.config.ts"]);
	});

	it("prefers the shallower config among equally canonical names", () => {
		expect(
			rank("apps/web/e2e/playwright.config.ts", "e2e/playwright.config.ts"),
		).toEqual([
			"e2e/playwright.config.ts",
			"apps/web/e2e/playwright.config.ts",
		]);
	});

	it("prefers the shallower config among equally non-canonical names", () => {
		expect(
			rank("a/b/playwright.ci.config.ts", "playwright.base.config.ts"),
		).toEqual(["playwright.base.config.ts", "a/b/playwright.ci.config.ts"]);
	});

	it("orders extensions the way Playwright resolves them", () => {
		expect(
			rank(
				"playwright.config.cjs",
				"playwright.config.js",
				"playwright.config.mts",
				"playwright.config.ts",
			),
		).toEqual([
			"playwright.config.ts",
			"playwright.config.mts",
			"playwright.config.js",
			"playwright.config.cjs",
		]);
	});

	// Directory read order is not stable across platforms or filesystems; a
	// tie-break that fell through to it would make the analysed config depend on
	// which machine ran the analysis.
	it("breaks a full tie lexicographically", () => {
		expect(
			rank("zeta/playwright.config.ts", "alpha/playwright.config.ts"),
		).toEqual(["alpha/playwright.config.ts", "zeta/playwright.config.ts"]);
	});

	it("drops duplicates and anything that is not a Playwright config", () => {
		expect(
			rank(
				"playwright.config.ts",
				"playwright.config.ts",
				"vite.config.ts",
				"vitest.config.ts",
			),
		).toEqual(["playwright.config.ts"]);
	});

	it("caps the ranked list", () => {
		const many = Array.from(
			{ length: MAX_CONFIG_CANDIDATES + 5 },
			(_unused, index) =>
				`pkg${String(index).padStart(2, "0")}/playwright.config.ts`,
		);
		const ranked = rank(...many);
		expect(ranked).toHaveLength(MAX_CONFIG_CANDIDATES);
		expect(ranked[0]).toBe("pkg00/playwright.config.ts");
	});
});
