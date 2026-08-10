import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Project } from "ts-morph";
import { afterEach, describe, expect, it } from "vitest";
import { buildCoverageReport } from "../../analysis/coverage/mapCoverage";
import { discoverPageObjects } from "../../analysis/page-objects/discover";
import { buildPageObjectTree } from "../../analysis/page-objects/tree";
import { buildTestIdTree } from "../../analysis/tsx/tree";
import { Workspace } from "../../analysis/workspace";
import { EXAMPLE_ROOT } from "./helpers/example";

/**
 * The type checker must never be materialised by a default tool call.
 *
 * Every one of the four tools is documented as a syntax-only walk, and the
 * engine is built that way — but `isDefaultExport()` and `isExported()` both
 * fall through to `getSymbol()` when the declaration carries no keyword, and
 * that one call builds `ts.Program`: on a production monorepo it read 594
 * `node_modules` declaration files, cost 53% of cold CPU and pinned hundreds of
 * megabytes of heap. Nothing in the output changed, so no assertion caught it.
 *
 * This is that assertion. `_isCompilerProgramCreated()` is ts-morph's own
 * internal flag for "has the program been instantiated yet", which is exactly
 * the question, and it is the only observable that distinguishes a syntactic
 * walk from one that quietly typechecks the world.
 */

/** ts-morph's internal "has the compiler program been built" flag. */
function programCreated(project: Project): boolean {
	const context = (
		project as unknown as {
			_context: { program: { _isCompilerProgramCreated(): boolean } };
		}
	)._context;
	return context.program._isCompilerProgramCreated();
}

const roots: string[] = [];

function scratch(files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppo-checker-"));
	roots.push(root);
	for (const [relativePath, contents] of Object.entries(files)) {
		const absolute = path.join(root, relativePath);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, contents, "utf8");
	}
	return root;
}

afterEach(() => {
	Workspace.reset();
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("no type checker on the default path", () => {
	it("stays syntactic across all four tools on the example app", () => {
		const ws = Workspace.acquire({ projectRoot: EXAMPLE_ROOT });
		expect(programCreated(ws.project)).toBe(false);

		discoverPageObjects(ws);
		expect(programCreated(ws.project)).toBe(false);

		buildPageObjectTree(ws, "CheckoutPage");
		expect(programCreated(ws.project)).toBe(false);

		buildTestIdTree(ws);
		expect(programCreated(ws.project)).toBe(false);

		buildCoverageReport(ws);
		expect(programCreated(ws.project)).toBe(false);
	});

	/**
	 * The forms that used to reach the checker, all in one repository: a
	 * keyword-less default export, a re-exported one, and a component whose
	 * declaration is a `const` — the node type that can never carry a `default`
	 * keyword and therefore *always* fell through.
	 */
	it("stays syntactic over keyword-less export forms", () => {
		const root = scratch({
			"src/Card.tsx": [
				"const Card = ({ testId }: { testId?: string }) => (",
				'\t<div data-testid={testId ?? "Card"} />',
				");",
				"export default Card;",
				"",
			].join("\n"),
			"src/Row.tsx": [
				"function Row() {",
				'\treturn <span data-testid="Row" />;',
				"}",
				"export { Row as default };",
				"",
			].join("\n"),
			"src/App.tsx": [
				'import Card from "./Card";',
				'import Row from "./Row";',
				"export const App = () => (",
				"\t<main>",
				'\t\t<Card testId="Top" />',
				"\t\t<Row />",
				"\t</main>",
				");",
				"",
			].join("\n"),
			"e2e/App.po.ts": [
				'import type { Locator } from "@playwright/test";',
				'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
				"",
				'@RootSelector("Card")',
				"class AppPage extends RootPageObject {",
				'\t@Selector("Row")',
				"\taccessor Row!: Locator;",
				"}",
				"export { AppPage as default };",
				"",
			].join("\n"),
		});

		const ws = Workspace.acquire({ projectRoot: root });
		discoverPageObjects(ws);
		buildPageObjectTree(ws, "AppPage");
		buildTestIdTree(ws);
		buildCoverageReport(ws);
		expect(programCreated(ws.project)).toBe(false);
	});

	it("still reports keyword-less default exports correctly", () => {
		const root = scratch({
			"e2e/Assigned.po.ts": [
				'import { RootPageObject, RootSelector } from "playwright-page-object";',
				"",
				'@RootSelector("Assigned")',
				"class AssignedPage extends RootPageObject {}",
				"export default AssignedPage;",
				"",
			].join("\n"),
			"e2e/Aliased.po.ts": [
				'import { RootPageObject, RootSelector } from "playwright-page-object";',
				"",
				'@RootSelector("Aliased")',
				"class AliasedPage extends RootPageObject {}",
				"export { AliasedPage as default };",
				"",
			].join("\n"),
			"e2e/Named.po.ts": [
				'import { RootPageObject, RootSelector } from "playwright-page-object";',
				"",
				'@RootSelector("Named")',
				"class NamedPage extends RootPageObject {}",
				"export { NamedPage };",
				"",
			].join("\n"),
			"e2e/Local.po.ts": [
				'import { RootPageObject, RootSelector } from "playwright-page-object";',
				"",
				'@RootSelector("Local")',
				"class LocalPage extends RootPageObject {}",
				"void LocalPage;",
				"",
			].join("\n"),
		});

		const ws = Workspace.acquire({ projectRoot: root });
		const index = discoverPageObjects(ws);
		const byName = new Map(
			index.pageObjects.map((entry) => [entry.className, entry]),
		);

		expect(byName.get("AssignedPage")).toMatchObject({
			isExported: true,
			isDefaultExport: true,
		});
		expect(byName.get("AliasedPage")).toMatchObject({
			isExported: true,
			isDefaultExport: true,
		});
		expect(byName.get("NamedPage")).toMatchObject({
			isExported: true,
			isDefaultExport: false,
		});
		expect(byName.get("LocalPage")).toMatchObject({
			isExported: false,
			isDefaultExport: false,
		});
		expect(programCreated(ws.project)).toBe(false);
	});
});
