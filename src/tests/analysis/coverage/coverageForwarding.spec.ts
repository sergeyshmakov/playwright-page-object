import { describe, expect, it } from "vitest";
import { buildCoverageReport } from "../../../analysis/coverage/mapCoverage";
import { libImport, makeWorkspace } from "../helpers/inMemory";

describe("buildCoverageReport — assuming forwarding", () => {
	const FILES = {
		"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
		"src/App.tsx": [
			'import Card from "./Card";',
			"export default function App() {",
			'  return <main><Card data-testid="Ghost" /></main>;',
			"}",
		].join("\n"),
		"src/Card.tsx": [
			"export default function Card(props: { children?: unknown }) {",
			"  return <div>{props.children as never}</div>;",
			"}",
		].join("\n"),
		"e2e/GhostPage.ts": [
			'import type { Locator } from "@playwright/test";',
			libImport("RootPageObject", "RootSelector", "Selector"),
			"@RootSelector()",
			"export class GhostPage extends RootPageObject {",
			'  @Selector("Ghost")',
			"  accessor Ghost!: Locator;",
			"}",
		].join("\n"),
	};

	it("promotes the prop id and labels every place the assumption shows", () => {
		const result = buildCoverageReport(makeWorkspace(FILES), {
			assumeForwarded: true,
		});
		expect(result.summary.matchableUiTestIds).toBe(1);
		expect(result.summary.assumedForwardedTestIds).toBe(1);
		expect(result.matched).toHaveLength(1);
		expect(result.matched[0].forwarding).toBe("assumed");
		expect(result.unknownSelectors).toEqual([]);
		const warning = result.warnings.find(
			(entry) => entry.code === "forwarding-assumed",
		);
		expect(warning?.severity).toBe("warning");
	});

	/**
	 * A promoted id belongs to exactly one bucket.
	 *
	 * `UnknownTestId` means "coverage could not treat this as rendered", and the
	 * whole point of the flag is that it now can. Leaving the occurrence under
	 * `forwarding-unproven` as well would contradict that contract and count the
	 * id twice in `summary.uiTestIds`, which is `matchable + unknown`.
	 */
	it("keeps a promoted prop id out of the unknown bucket", () => {
		const result = buildCoverageReport(makeWorkspace(FILES), {
			assumeForwarded: true,
		});
		expect(
			result.unknownTestIds.filter(
				(entry) => entry.reason === "forwarding-unproven",
			),
		).toEqual([]);
		expect(result.summary.unknownTestIds).toBe(result.unknownTestIds.length);
		expect(result.summary.uiTestIds).toBe(
			result.summary.matchableUiTestIds + result.summary.unknownTestIds,
		);
	});

	it("does report it as unproven when the flag is off", () => {
		const result = buildCoverageReport(makeWorkspace(FILES));
		expect(result.unknownTestIds.map((entry) => entry.reason)).toContain(
			"forwarding-unproven",
		);
		expect(result.summary.matchableUiTestIds).toBe(0);
	});

	it("says nothing about assuming anything when the flag is off", () => {
		const result = buildCoverageReport(makeWorkspace(FILES));
		expect(result.summary.assumedForwardedTestIds).toBeUndefined();
		expect(result.warnings.map((entry) => entry.code)).not.toContain(
			"forwarding-assumed",
		);
	});

	it("suggests the flag once enough selectors land in the unproven bucket", () => {
		const many = {
			...FILES,
			"src/App.tsx": [
				'import Card from "./Card";',
				"export default function App() {",
				"  return (",
				"    <main>",
				'      <Card data-testid="Ghost" />',
				'      <Card data-testid="Phantom" />',
				'      <Card data-testid="Wraith" />',
				"    </main>",
				"  );",
				"}",
			].join("\n"),
			"e2e/GhostPage.ts": [
				'import type { Locator } from "@playwright/test";',
				libImport("RootPageObject", "RootSelector", "Selector"),
				"@RootSelector()",
				"export class GhostPage extends RootPageObject {",
				'  @Selector("Ghost")',
				"  accessor A!: Locator;",
				'  @Selector("Phantom")',
				"  accessor B!: Locator;",
				'  @Selector("Wraith")',
				"  accessor C!: Locator;",
				"}",
			].join("\n"),
		};
		const result = buildCoverageReport(makeWorkspace(many));
		const widespread = result.warnings.find(
			(entry) => entry.code === "forwarding-unproven-widespread",
		);
		expect(widespread?.severity).toBe("info");
		expect(widespread?.data?.unproven).toBe(3);
	});
});

/**
 * A monorepo pointed at one app renders half its UI from sibling packages. Test
 * ids in those are invisible here, so every selector for one reads as dead —
 * and the report used to say so without a word about the scope it was reading.
 */
describe("buildCoverageReport — component tags from outside the scan", () => {
	const EXTERNAL = {
		"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
		"src/App.tsx": [
			'import { Gapped } from "@design/ui";',
			"export default function App() {",
			'  return <main><Gapped /><div data-testid="Local" /></main>;',
			"}",
		].join("\n"),
	};

	const pageObject = (id: string) => ({
		"e2e/AppPage.ts": [
			'import type { Locator } from "@playwright/test";',
			libImport("RootPageObject", "RootSelector", "Selector"),
			"@RootSelector()",
			"export class AppPage extends RootPageObject {",
			`  @Selector(${JSON.stringify(id)})`,
			"  accessor Thing!: Locator;",
			"}",
		].join("\n"),
	});

	it("counts the boundary and names the module", () => {
		const result = buildCoverageReport(
			makeWorkspace({ ...EXTERNAL, ...pageObject("Local") }),
		);
		expect(result.scope.externalComponentModules).toEqual(["@design/ui"]);
		expect(result.scope.externalComponentTags).toBe(1);
		expect(result.scope.uiFilesScanned).toBeGreaterThan(0);
		expect(result.scope.pageObjectFilesScanned).toBeGreaterThan(0);
	});

	/**
	 * The list of modules is capped at ten for display. The *count* beside it was
	 * read off that capped array, so every repository with ten or more external
	 * modules was told it had exactly ten — the number saturated silently, and a
	 * reader sizing their blind spot on a 44-module app underestimated it more
	 * than four-fold. A capped list is fine; a capped number is a false claim.
	 */
	it("reports how many modules there are, not how many it printed", () => {
		const tags = Array.from({ length: 25 }, (_, index) => `<C${index} />`).join(
			"",
		);
		const imports = Array.from(
			{ length: 25 },
			(_, index) => `import { C${index} } from "@design/pkg${index}";`,
		).join("\n");
		const result = buildCoverageReport(
			makeWorkspace({
				"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
				"src/App.tsx": [
					imports,
					"export default function App() {",
					`  return <main>${tags}<div data-testid="Local" /></main>;`,
					"}",
				].join("\n"),
				...pageObject("Local"),
			}),
		);

		expect(result.scope.externalComponentModules).toHaveLength(10);
		const scope = result.warnings.find(
			(entry) => entry.code === "ui-scope-incomplete",
		);
		expect(scope?.data?.modules).toBe(25);
		expect(scope?.message).toContain("25 module(s)");
		// And it must admit the list is a sample rather than let the reader take
		// ten names as the whole set next to a count of 25.
		expect(scope?.message).toContain("first 10 by name");
	});

	it("stays informational while nothing looks broken", () => {
		const result = buildCoverageReport(
			makeWorkspace({ ...EXTERNAL, ...pageObject("Local") }),
		);
		expect(result.deadSelectors).toEqual([]);
		expect(
			result.warnings.find((entry) => entry.code === "ui-scope-incomplete")
				?.severity,
		).toBe("info");
	});

	it("becomes a warning the moment a selector reads as dead", () => {
		const result = buildCoverageReport(
			makeWorkspace({ ...EXTERNAL, ...pageObject("InsideGapped") }),
		);
		expect(result.deadSelectors).toHaveLength(1);
		const scope = result.warnings.find(
			(entry) => entry.code === "ui-scope-incomplete",
		);
		expect(scope?.severity).toBe("warning");
		expect(scope?.message).toContain("@design/ui");
		expect(scope?.message).not.toContain("monorepo");
	});

	// The global warning is the remediation; the flag is what an agent reading
	// one entry — or a list `limit` cut short — actually has in front of it.
	it("carries the caveat on every dead entry, typo discriminator intact", () => {
		const result = buildCoverageReport(
			makeWorkspace({
				...EXTERNAL,
				"e2e/AppPage.ts": [
					'import type { Locator } from "@playwright/test";',
					libImport("RootPageObject", "RootSelector", "Selector"),
					"@RootSelector()",
					"export class AppPage extends RootPageObject {",
					'  @Selector("InsideGapped")',
					"  accessor Hidden!: Locator;",
					'  @Selector("Locl")',
					"  accessor Typo!: Locator;",
					"}",
				].join("\n"),
			}),
		);

		expect(result.deadSelectors).toHaveLength(2);
		expect(result.summary.deadSelectors).toBe(2);
		expect(
			result.deadSelectors.every((entry) => entry.scopeIncomplete === true),
			"the scan is what is incomplete, so the caveat is uniform",
		).toBe(true);

		// Same flag, two different readings, and the discriminator is the one
		// piece of per-entry evidence that is real.
		const byPath = (memberPath: string) =>
			result.deadSelectors.find((entry) => entry.memberPath === memberPath);
		expect(byPath("AppPage.Hidden")?.nearestTestIds).toEqual([]);
		expect(byPath("AppPage.Typo")?.nearestTestIds).toContain("Local");

		const scope = result.warnings.find(
			(entry) => entry.code === "ui-scope-incomplete",
		);
		expect(scope?.message).toContain("scopeIncomplete");
	});

	// Measured backwards on a production monorepo: of 8 selectors that were not
	// really dead, 6 had an empty `nearestTestIds` (their ids render inside an
	// unscanned package, so nothing in scope resembles them), while 3 of the 5
	// genuinely dead ones had a near match — the old spelling a rename left
	// behind. The advice used to send the reader at the empty ones first.
	it("triages towards the near match, not away from it", () => {
		const result = buildCoverageReport(
			makeWorkspace({ ...EXTERNAL, ...pageObject("InsideGapped") }),
		);
		const message =
			result.warnings.find((entry) => entry.code === "ui-scope-incomplete")
				?.message ?? "";
		expect(message).toContain("non-empty list is the actionable case");
		expect(message).not.toContain("start with the ones whose nearestTestIds");
	});

	// An unfollowable remedy is worse than none: `--src-dir` outside the project
	// root is refused at startup, so "add their directories to the scan" cost a
	// server restart and taught nothing.
	it("never offers a wider scan as the remedy for an out-of-root module", () => {
		const result = buildCoverageReport(
			makeWorkspace({ ...EXTERNAL, ...pageObject("InsideGapped") }),
		);
		const message =
			result.warnings.find((entry) => entry.code === "ui-scope-incomplete")
				?.message ?? "";
		expect(message).not.toContain("added to the scanned sources");
		// Nothing resolves in an in-memory fixture, so this is the "no sources to
		// reach" branch: it must not promise a re-root that would find nothing.
		expect(message).toContain("do not resolve at all");
	});

	it("does not count a relative import as a boundary", () => {
		const result = buildCoverageReport(
			makeWorkspace({
				...EXTERNAL,
				"src/App.tsx": [
					'import { Gapped } from "./Gapped";',
					"export default function App() {",
					'  return <main><Gapped /><div data-testid="Local" /></main>;',
					"}",
				].join("\n"),
				"src/Gapped.tsx":
					'export function Gapped() { return <b data-testid="Inner" />; }',
				...pageObject("Local"),
			}),
		);
		expect(result.scope.externalComponentTags).toBe(0);
		expect(result.warnings.map((entry) => entry.code)).not.toContain(
			"ui-scope-incomplete",
		);
	});
});
