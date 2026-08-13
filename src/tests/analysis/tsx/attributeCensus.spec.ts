import { describe, expect, it } from "vitest";
import {
	attributeVerdict,
	censusFromText,
} from "../../../analysis/tsx/attributeCensus";
import { makeWorkspace } from "../helpers/inMemory";

/**
 * The sanity check that stands between "the attribute resolved to X" and "X is
 * what the sources use". Everything downstream reads test ids by attribute
 * name, and a wrong name fails open: empty tree, dead selectors, coverage 1.
 */

const APP = [
	"export const App = () => (",
	'\t<div data-tid="Root">',
	'\t\t<input data-tid="Email" aria-label="Email" />',
	'\t\t<button data-tid="Submit" aria-hidden="true">Go</button>',
	"\t</div>",
	");",
].join("\n");

describe("censusFromText", () => {
	it("stops at the first hit and never tallies alternatives", () => {
		const ws = makeWorkspace({ "src/App.tsx": APP });
		const census = censusFromText(ws, "data-tid");
		expect(census.resolvedCount).toBe(3);
		expect(census.sampled).toBe(true);
		expect(
			census.candidates,
			"phase two is pure cost on a healthy repository",
		).toEqual([]);
		expect(attributeVerdict(census, "playwright-config")).toBeNull();
	});

	it("counts the JSX files in scope, not every source file", () => {
		const ws = makeWorkspace({
			"src/App.tsx": APP,
			"src/Other.tsx": 'export const O = () => <b data-tid="x" />;',
			"e2e/Page.ts": "export class Page {}",
		});
		expect(censusFromText(ws, "data-testid").files).toBe(2);
	});

	it("respects an include scope", () => {
		const ws = makeWorkspace(
			{
				"src/App.tsx": APP,
				"legacy/Old.tsx": 'export const O = () => <b data-tid="x" />;',
			},
			{ include: ["src/**"] },
		);
		expect(censusFromText(ws, "data-testid").files).toBe(1);
	});

	// A comment or a README line mentioning the attribute must not be able to
	// silence the check; the needle is the attribute *in attribute position*.
	it("does not count a bare mention of the name", () => {
		const ws = makeWorkspace({
			"src/App.tsx": [
				"// migrated away from data-testid in 2024",
				'export const App = () => <div data-tid="Root" />;',
			].join("\n"),
		});
		expect(censusFromText(ws, "data-testid").resolvedCount).toBe(0);
	});

	// `qa-data-testid=` contains `data-testid=`. As a substring scan this
	// reported evidence for an attribute the repository never writes, and the
	// mismatch warning that should have named `qa-data-testid` went unsaid.
	it("does not count a longer attribute that ends with the name", () => {
		const ws = makeWorkspace({
			"src/App.tsx": [
				"export const App = () => (",
				'\t<div qa-data-testid="Root">',
				'\t\t<b qa-data-testid="A" />',
				"\t</div>",
				");",
			].join("\n"),
		});
		const census = censusFromText(ws, "data-testid");
		expect(census.resolvedCount).toBe(0);
		expect(census.candidates).toEqual([{ name: "qa-data-testid", count: 2 }]);
		expect(attributeVerdict(census, "playwright-config")?.code).toBe(
			"attribute-mismatch",
		);
	});

	// Whitespace around the equals sign is legal JSX.
	it("counts an attribute written with spaces around the equals sign", () => {
		const ws = makeWorkspace({
			"src/App.tsx": 'export const App = () => <div data-tid = "Root" />;',
		});
		const census = censusFromText(ws, "data-tid");
		expect(census.resolvedCount).toBe(1);
		expect(attributeVerdict(census, "playwright-config")).toBeNull();
	});

	it("ranks the alternatives it found, most frequent first", () => {
		const ws = makeWorkspace({
			"src/App.tsx": [
				"export const App = () => (",
				'\t<div data-tid="Root">',
				'\t\t<b data-tid="A" />',
				'\t\t<i qa-id="B" />',
				'\t\t<i qa-id="C" />',
				'\t\t<u data-tid="D" />',
				"\t</div>",
				");",
			].join("\n"),
		});
		const census = censusFromText(ws, "data-testid");
		expect(census.resolvedCount).toBe(0);
		expect(census.candidates).toEqual([
			{ name: "data-tid", count: 3 },
			{ name: "qa-id", count: 2 },
		]);
	});

	// Accessibility attributes are hyphenated and everywhere; offering
	// `aria-label` as the repository's test-id convention would be noise.
	it("never offers an aria attribute as a candidate", () => {
		const ws = makeWorkspace({
			"src/App.tsx": [
				"export const App = () => (",
				'\t<div aria-label="a"><b aria-hidden="true" /><i aria-live="off" /></div>',
				");",
			].join("\n"),
		});
		expect(censusFromText(ws, "data-testid").candidates).toEqual([]);
	});

	it("re-runs against the attribute a caller actually used", () => {
		const ws = makeWorkspace({ "src/App.tsx": APP });
		expect(censusFromText(ws, "data-testid").resolvedCount).toBe(0);
		expect(censusFromText(ws, "data-tid").resolvedCount).toBe(3);
	});

	it("is memoized per epoch and recomputed after a bump", () => {
		const ws = makeWorkspace({ "src/App.tsx": APP });
		const first = censusFromText(ws, "data-tid");
		expect(censusFromText(ws, "data-tid")).toBe(first);
		ws.bumpEpoch();
		expect(censusFromText(ws, "data-tid")).not.toBe(first);
	});
});

describe("attributeVerdict", () => {
	function verdictFor(
		files: Record<string, string>,
		attribute = "data-testid",
	) {
		return attributeVerdict(
			censusFromText(makeWorkspace(files), attribute),
			"playwright-config",
		);
	}

	it("names the attribute, its source, and the dominant candidate", () => {
		const verdict = verdictFor({
			"src/App.tsx": [
				"export const App = () => (",
				'\t<div data-tid="Root"><b data-tid="A" /><i qa-id="B" /><u qa-id="C" /></div>',
				");",
			].join("\n"),
		});
		expect(verdict?.code).toBe("attribute-mismatch");
		expect(verdict?.severity).toBe("warning");
		expect(verdict?.message).toContain("data-testid");
		expect(verdict?.message).toContain("read from the Playwright config");
		expect(verdict?.message).toContain('"data-tid"');
		expect(verdict?.data).toMatchObject({
			attribute: "data-testid",
			attributeSource: "playwright-config",
			candidate: "data-tid",
			candidateCount: 2,
			runnerUp: "qa-id",
			runnerUpCount: 2,
		});
	});

	it("falls back to no-evidence when nothing stands out", () => {
		const verdict = verdictFor({
			"src/App.tsx": 'export const App = () => <div className="x" />;',
		});
		expect(verdict?.code).toBe("attribute-no-evidence");
	});

	// One occurrence of a hyphenated attribute is as likely to be `data-icon` or
	// a string in a comment as it is to be the repository's convention. Naming it
	// would send a caller off to restart against an attribute matching one node.
	it("refuses to name a candidate seen exactly once", () => {
		const verdict = verdictFor({
			"src/App.tsx": 'export const App = () => <div data-icon="star" />;',
		});
		expect(verdict?.code).toBe("attribute-no-evidence");
	});

	it("reports an empty JSX scope as a scope problem, not an attribute one", () => {
		const verdict = verdictFor({ "e2e/Page.ts": "export class Page {}" });
		expect(verdict?.code).toBe("scope-empty");
		expect(verdict?.data?.kind).toBe("jsx");
	});

	it("says nothing when the attribute is present", () => {
		expect(verdictFor({ "src/App.tsx": APP }, "data-tid")).toBeNull();
	});
});
