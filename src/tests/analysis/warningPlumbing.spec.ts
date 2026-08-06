import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCoverageReport } from "../../analysis/coverage/mapCoverage";
import { discoverPageObjects } from "../../analysis/page-objects/discover";
import { buildPageObjectTree } from "../../analysis/page-objects/tree";
import { buildTestIdTree } from "../../analysis/tsx/tree";
import type { Diagnostic } from "../../analysis/types";
import { Workspace } from "../../analysis/workspace";

/**
 * The regression this whole cluster exists for.
 *
 * A repository whose Playwright config sits somewhere the old fixed-basename
 * probe never looked, and whose components use `data-tid`. Before the fix every
 * one of the four payloads came back structurally valid and completely wrong:
 * an empty test-id tree, page-object selectors matching nothing, and a coverage
 * report reading `1` because zero of zero ids were covered — with `warnings`
 * empty in three of the four, because only `discoverPageObjects` ever seeded
 * itself from the workspace.
 *
 * So the assertion is not "the engine handles this shape". It is: whichever of
 * the four entry points a caller reaches for, the payload says the environment
 * is wrong.
 */

let root: string;

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ppo-plumbing-"));
	const write = (relative: string, body: string) => {
		const absolute = path.join(root, relative);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, body, "utf8");
	};

	// Nested, non-canonical basename, and the attribute is computed — so it is
	// found, read, and still yields nothing usable. The analysis falls back to
	// `data-testid`; the sources say otherwise.
	write(
		"tooling/playwright/playwright.base.config.ts",
		[
			'import { defineConfig } from "@playwright/test";',
			"export default defineConfig({ use: { testIdAttribute: process.env.ATTR } });",
		].join("\n"),
	);
	write(
		"src/App.tsx",
		[
			"export function App() {",
			"\treturn (",
			'\t\t<div data-tid="AppRoot">',
			'\t\t\t<input data-tid="EmailInput" />',
			'\t\t\t<button data-tid="SubmitButton">Go</button>',
			"\t\t</div>",
			"\t);",
			"}",
			"",
		].join("\n"),
	);
	write(
		"e2e/LoginPage.ts",
		[
			'import type { Locator } from "@playwright/test";',
			'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
			"",
			'@RootSelector("AppRoot")',
			"export class LoginPage extends RootPageObject {",
			'\t@Selector("EmailInput")',
			"\taccessor Email!: Locator;",
			"}",
			"",
		].join("\n"),
	);
	Workspace.reset();
});

afterAll(() => {
	Workspace.reset();
	fs.rmSync(root, { recursive: true, force: true });
});

function workspace(): Workspace {
	return Workspace.acquire({ projectRoot: root });
}

const builders: Array<[string, () => Diagnostic[]]> = [
	["discoverPageObjects", () => discoverPageObjects(workspace()).warnings],
	[
		"buildPageObjectTree",
		() => buildPageObjectTree(workspace(), "LoginPage").warnings,
	],
	["buildTestIdTree", () => buildTestIdTree(workspace()).warnings],
	["buildCoverageReport", () => buildCoverageReport(workspace()).warnings],
];

describe("every payload carries the environment verdict", () => {
	it.each(builders)("%s reports the attribute mismatch", (_name, run) => {
		const codes = run().map((warning) => warning.code);
		expect(codes).toContain("attribute-mismatch");
	});

	it.each(builders)("%s reports the unreadable config", (_name, run) => {
		const codes = run().map((warning) => warning.code);
		expect(codes).toContain("testid-attribute-unresolved");
	});

	it("names the attribute the sources actually use", () => {
		const mismatch = buildTestIdTree(workspace()).warnings.find(
			(warning) => warning.code === "attribute-mismatch",
		);
		expect(mismatch?.data?.attribute).toBe("data-testid");
		expect(mismatch?.data?.candidate).toBe("data-tid");
		expect(mismatch?.data?.candidateCount).toBe(3);
	});

	// The number that made the failure invisible in the field: nothing matched,
	// nothing was matchable, so the ratio came out perfect.
	it("still reports the misleadingly perfect coverage, but not silently", () => {
		const report = buildCoverageReport(workspace());
		expect(report.summary.matchableUiTestIds).toBe(0);
		expect(report.summary.coverage).toBe(1);
		expect(report.warnings.map((warning) => warning.code)).toContain(
			"attribute-mismatch",
		);
	});

	// A caller passing the right attribute has fixed the problem for that call;
	// the census has to be run against the name that was actually used.
	it("goes quiet once the correct attribute is supplied", () => {
		const codes = buildTestIdTree(workspace(), {
			attribute: "data-tid",
		}).warnings.map((warning) => warning.code);
		expect(codes).not.toContain("attribute-mismatch");
		expect(
			buildTestIdTree(workspace(), { attribute: "data-tid" }).inventory,
		).toHaveLength(3);
	});
});
