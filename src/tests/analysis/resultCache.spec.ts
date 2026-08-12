import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestIdTree } from "../../analysis";
import { buildCoverageReport } from "../../analysis/coverage/mapCoverage";
import { buildPageObjectTree } from "../../analysis/page-objects/tree";
import { buildTestIdTree } from "../../analysis/tsx/tree";
import { WorkspacePool } from "../../analysis/workspace";
import {
	cleanupScratchRoots,
	scratchRepo,
	writeIn as write,
} from "./helpers/onDisk";

/**
 * The three builders are memoized per epoch, which is the whole reason a repeat
 * tool call is cheap. These lock the two properties that makes safe: the cache
 * key covers everything that changes the answer, and it misses whenever the
 * files the answer was computed from have moved on.
 */

/** One per spec file, so nothing leaks between them. */
const pool = new WorkspacePool();

function scratch(files: Record<string, string>): string {
	return scratchRepo(files, { prefix: "ppo-memo-" });
}

afterEach(() => {
	pool.clear();
	cleanupScratchRoots();
});

const PAGE_OBJECT = [
	'import type { Locator } from "@playwright/test";',
	'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
	"",
	'@RootSelector("Root")',
	"export class HomePage extends RootPageObject {",
	'\t@Selector("Title")',
	"\taccessor Title!: Locator;",
	"",
	"\tasync open() {}",
	"}",
	"",
].join("\n");

const APP = [
	"export const App = () => (",
	'\t<div data-testid="Root">',
	'\t\t<h1 data-testid="Title">hi</h1>',
	"\t</div>",
	");",
	"",
].join("\n");

function sampleRepo(): string {
	return scratch({ "src/App.tsx": APP, "e2e/Home.po.ts": PAGE_OBJECT });
}

describe("builder result cache", () => {
	it("hands the identical object back on a repeat call", () => {
		const ws = pool.acquire({ projectRoot: sampleRepo() });
		expect(buildTestIdTree(ws)).toBe(buildTestIdTree(ws));
		expect(buildCoverageReport(ws)).toBe(buildCoverageReport(ws));
		expect(buildPageObjectTree(ws, "HomePage")).toBe(
			buildPageObjectTree(ws, "HomePage"),
		);
	});

	it("keys on the options that change the answer", () => {
		const ws = pool.acquire({ projectRoot: sampleRepo() });
		expect(buildTestIdTree(ws, { maxDepth: 2 })).not.toBe(
			buildTestIdTree(ws, { maxDepth: 3 }),
		);
		expect(buildTestIdTree(ws, { attribute: "data-tid" })).not.toBe(
			buildTestIdTree(ws),
		);
		expect(buildTestIdTree(ws, { followComponents: false })).not.toBe(
			buildTestIdTree(ws),
		);
		expect(buildCoverageReport(ws, { assumeForwarded: true })).not.toBe(
			buildCoverageReport(ws),
		);
		expect(buildCoverageReport(ws, { includeRawLocators: true })).not.toBe(
			buildCoverageReport(ws),
		);
	});

	it("treats an explicit attribute as a different question from the default", () => {
		const ws = pool.acquire({ projectRoot: sampleRepo() });
		expect(buildTestIdTree(ws).attributeSource).toBe("default");
		expect(
			buildTestIdTree(ws, { attribute: "data-testid" }).attributeSource,
		).toBe("param");
	});

	it("misses after revalidate picks up an edit", () => {
		const root = sampleRepo();
		const ws = pool.acquire({ projectRoot: root });
		const staticIds = (tree: TestIdTree) =>
			tree.inventory.map((entry) =>
				entry.value.kind === "static" ? entry.value.value : undefined,
			);
		const before = buildTestIdTree(ws);
		expect(staticIds(before)).toContain("Title");

		write(root, "src/App.tsx", APP.replace('"Title"', '"Heading"'));
		// A second write inside the same millisecond leaves the mtime the sweep
		// compares unchanged; the stamp is what a real edit moves.
		const later = new Date(Date.now() + 5_000);
		fs.utimesSync(path.join(root, "src/App.tsx"), later, later);
		expect(ws.revalidate().changed).toContain("src/App.tsx");

		const after = buildTestIdTree(ws);
		expect(after).not.toBe(before);
		expect(staticIds(after)).toContain("Heading");
		expect(staticIds(after)).not.toContain("Title");
	});

	it("does not cache a throw", () => {
		const ws = pool.acquire({ projectRoot: sampleRepo() });
		expect(() => buildPageObjectTree(ws, "NoSuchPage")).toThrow();
		expect(() => buildPageObjectTree(ws, "NoSuchPage")).toThrow();
		expect(buildPageObjectTree(ws, "HomePage").root).toContain("HomePage");
	});

	/**
	 * The hazard the cache had to close before it could exist.
	 *
	 * The resolver adds files to the project mid-walk without bumping the epoch,
	 * so the first call builds its component inventory from a file list that is
	 * already out of date by the time the walk finishes. Today the next call is
	 * more complete because it recomputes; a cache keyed on the epoch alone would
	 * have frozen the incomplete answer for the life of the session.
	 */
	it("recomputes after the walk pulled a new file into the project", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { jsx: "react-jsx", target: "ES2022" },
				// Deliberately one file: `Card.tsx` reaches the project only because
				// the walk resolves the import to it.
				include: ["src/main.tsx"],
			}),
			"src/main.tsx": [
				'import { Card } from "./Card";',
				"export const Main = () => (",
				'\t<div data-testid="Root">',
				"\t\t<Card />",
				"\t</div>",
				");",
				"",
			].join("\n"),
			"src/Card.tsx": [
				"export const Card = () => (",
				'\t<span data-testid="CardId" />',
				");",
				"",
			].join("\n"),
		});

		const ws = pool.acquire({ projectRoot: root });
		const first = buildTestIdTree(ws, { entry: "src/main.tsx" });
		expect(
			Object.values(first.components).map((component) => component.name),
		).not.toContain("Card");

		const second = buildTestIdTree(ws, { entry: "src/main.tsx" });
		expect(second).not.toBe(first);
		expect(
			Object.values(second.components).map((component) => component.name),
		).toContain("Card");

		// And once nothing new is admitted, the cache sticks.
		expect(buildTestIdTree(ws, { entry: "src/main.tsx" })).toBe(second);
	});
});
