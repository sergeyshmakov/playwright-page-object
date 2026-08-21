import { describe, expect, it } from "vitest";
import { CoverageHandles } from "../../mcp/handles";
import {
	handleGetPageObjectTree,
	handleGetTestIdTree,
	handleListPageObjects,
	handleMapCoverage,
	handleQueryCoverage,
} from "../../mcp/tools";
import { WarningLedger } from "../../mcp/warnings";
import { libImport, makeWorkspace } from "../analysis/helpers/inMemory";

/**
 * The handlers called directly, with a `Workspace` and nothing else.
 *
 * Every one takes the workspace as a plain first parameter and the session as
 * an optional third, which is a seam that has always existed in the signature
 * and had no callers: all 72 of the other MCP specs boot a `Client`/`Server`
 * pair over a linked transport and write a repository to a temp directory
 * first. That is the right shape for what only the wire can prove — schema
 * validation, `safeHandler`, `isError` mapping, the stdio handshake — and an
 * expensive way to ask what a payload contains.
 *
 * These are the payload questions. An in-memory workspace parses fixture text
 * with no filesystem, so a case takes milliseconds and reads as the shape it is
 * about rather than as a directory listing.
 */

const APP = {
	"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
	"src/App.tsx": [
		"export default function App() {",
		"  return (",
		"    <main>",
		'      <input data-testid="PromoInput" />',
		'      <button data-testid="ApplyButton" />',
		'      <span data-testid="Orphan" />',
		"    </main>",
		"  );",
		"}",
	].join("\n"),
	"e2e/HomePage.ts": [
		'import type { Locator } from "@playwright/test";',
		libImport("RootPageObject", "RootSelector", "Selector"),
		"@RootSelector()",
		"export class HomePage extends RootPageObject {",
		'  @Selector("PromoInput")',
		"  accessor Promo!: Locator;",
		'  @Selector("Missing")',
		"  accessor Gone!: Locator;",
		"}",
	].join("\n"),
};

/** The JSON envelope a handler produced, without booting anything. */
function envelope(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0].text) as {
		ok: boolean;
		data?: Record<string, unknown>;
		meta?: Record<string, unknown>;
		error?: { code: string; message?: string; hint?: string };
	};
}

describe("handleListPageObjects", () => {
	it("returns the index with paging metadata", () => {
		const out = envelope(
			handleListPageObjects(makeWorkspace(APP), { limit: 100, offset: 0 }),
		);
		expect(out.ok).toBe(true);
		expect(out.meta?.total).toBe(1);
		expect(JSON.stringify(out.data)).toContain("HomePage");
	});

	it("hints when a filter matched nothing but the index is not empty", () => {
		// The answer an agent is most likely to misread: an empty list looks like
		// "no page objects" when it means "your filter was wrong".
		const out = envelope(
			handleListPageObjects(makeWorkspace(APP), {
				filter: "nosuchthing",
				limit: 100,
				offset: 0,
			}),
		);
		expect(out.meta?.total).toBe(0);
		expect(String(out.meta?.hint)).toContain("nosuchthing");
	});
});

describe("handleGetPageObjectTree", () => {
	it("refuses without a target, and says what to pass", () => {
		expect(() =>
			handleGetPageObjectTree(makeWorkspace(APP), {
				depth: 3,
				includeMethods: true,
				format: "outline",
			}),
		).toThrowError(/class.*file/i);
	});

	it("returns the outline by default and JSON on request", () => {
		const ws = makeWorkspace(APP);
		const args = { depth: 3, includeMethods: true } as const;
		const outline = envelope(
			handleGetPageObjectTree(ws, {
				...args,
				class: "HomePage",
				format: "outline",
			}),
		);
		// Outline is a string; JSON is a structure. That difference is the whole
		// contract of the `format` argument.
		expect(typeof outline.data).toBe("string");
		expect(outline.data as unknown as string).toContain("HomePage");

		const json = envelope(
			handleGetPageObjectTree(ws, {
				...args,
				class: "HomePage",
				format: "json",
			}),
		);
		expect(typeof json.data).toBe("object");
		expect(json.data).toHaveProperty("defs");
	});
});

describe("handleGetTestIdTree", () => {
	it("walks a component and reports the ids it renders", () => {
		const out = envelope(
			handleGetTestIdTree(makeWorkspace(APP), {
				component: "App",
				depth: 4,
				followComponents: true,
				format: "outline",
			}),
		);
		expect(out.ok).toBe(true);
		expect(out.data as unknown as string).toContain("PromoInput");
	});

	it("looks an id up across the scan, whatever the walk did", () => {
		const out = envelope(
			handleGetTestIdTree(makeWorkspace(APP), {
				testId: "Orphan",
				depth: 4,
				followComponents: true,
				format: "outline",
			}),
		);
		// A testId lookup always returns JSON occurrences, never an outline.
		expect(out.ok).toBe(true);
		expect(JSON.stringify(out.data)).toContain("Orphan");
	});

	it("labels a per-call forwarding assumption without rewriting source evidence", () => {
		const forwardingApp = {
			"src/App.tsx": [
				"function Card() { return <div />; }",
				'export function App() { return <Card data-testid="Ghost" />; }',
			].join("\n"),
		};
		const out = envelope(
			handleGetTestIdTree(makeWorkspace(forwardingApp), {
				testId: "Ghost",
				depth: 4,
				followComponents: true,
				format: "json",
				assumeForwarded: true,
			}),
		);
		const data = out.data as {
			occurrences: Array<{ reach: string }>;
		};

		expect(out.meta?.assumeForwarded).toBe(true);
		expect(data.occurrences[0]?.reach).toBe("component-prop");
		expect(String(out.meta?.hint)).toContain("treats it as rendered");
	});
});

describe("handleMapCoverage", () => {
	it("compares both sides and reports the summary", () => {
		const out = envelope(
			handleMapCoverage(makeWorkspace(APP), {
				includeRawLocators: false,
				limit: 50,
				offset: 0,
			}),
		);
		const summary = (out.data as { summary: Record<string, number> }).summary;
		expect(summary.matched).toBe(1);
		expect(summary.deadSelectors).toBe(1);
	});

	it("returns only the requested buckets, and says what it ignored", () => {
		const out = envelope(
			handleMapCoverage(makeWorkspace(APP), {
				buckets: ["deadSelectors"],
				includeUnused: true,
				includeRawLocators: false,
				limit: 50,
				offset: 0,
			}),
		);
		expect(out.data).toHaveProperty("deadSelectors");
		expect(out.data).not.toHaveProperty("matched");
		// `buckets` wins over `includeUnused`, and the loser is named rather than
		// dropped in silence.
		expect(JSON.stringify(out.meta?.ignored)).toContain("includeUnused");
	});

	it("lets a tool call override the server forwarding default both ways", () => {
		const forwardingApp = {
			"src/App.tsx": [
				"function Card() { return <div />; }",
				'export function App() { return <Card data-testid="Ghost" />; }',
			].join("\n"),
			"e2e/GhostPage.ts": [
				libImport("RootPageObject", "RootSelector", "Selector"),
				"@RootSelector()",
				"export class GhostPage extends RootPageObject {",
				'  @Selector("Ghost") accessor Ghost!: unknown;',
				"}",
			].join("\n"),
		};
		const ws = makeWorkspace(forwardingApp);
		const enabled = envelope(
			handleMapCoverage(
				ws,
				{
					assumeForwarded: true,
					includeRawLocators: false,
					limit: 50,
					offset: 0,
				},
				{ assumeForwarded: false },
			),
		);
		const disabled = envelope(
			handleMapCoverage(
				ws,
				{
					assumeForwarded: false,
					includeRawLocators: false,
					limit: 50,
					offset: 0,
				},
				{ assumeForwarded: true },
			),
		);

		expect(
			(enabled.data as { summary: { matched: number } }).summary.matched,
		).toBe(1);
		expect(enabled.meta?.assumeForwarded).toBe(true);
		expect(
			(disabled.data as { summary: { matched: number } }).summary.matched,
		).toBe(0);
		expect(disabled.meta?.assumeForwarded).toBeUndefined();
	});
});

describe("handleQueryCoverage", () => {
	it("spends a handle minted by map_coverage", () => {
		const ws = makeWorkspace(APP);
		const handles = new CoverageHandles();
		const first = envelope(
			handleMapCoverage(
				ws,
				{ includeRawLocators: false, limit: 50, offset: 0 },
				{ handles },
			),
		);
		const coverageId = first.meta?.coverageId as string;
		expect(coverageId).toBeDefined();

		const page = envelope(
			handleQueryCoverage(
				ws,
				{ coverageId, bucket: "deadSelectors", limit: 50, offset: 0 },
				handles,
			),
		);
		expect(page.ok).toBe(true);
		expect(JSON.stringify(page.data)).toContain("Missing");
	});

	it("refuses an id this server never issued, recoverably", () => {
		expect(() =>
			handleQueryCoverage(
				makeWorkspace(APP),
				{
					coverageId: "cov_nope",
					bucket: "matched",
					limit: 50,
					offset: 0,
				},
				new CoverageHandles(),
			),
		).toThrowError(/not known to this server/);
	});
});

describe("the session, which is what makes these calls optional", () => {
	it("sends a warning in full once and abbreviates the repeat", () => {
		// The ledger is per-session state, so its behaviour only appears across
		// two calls that share one - previously reachable only by making two
		// round trips through a client.
		const ws = makeWorkspace(APP);
		const warnings = new WarningLedger();
		const first = envelope(
			handleListPageObjects(ws, { limit: 100, offset: 0 }, { warnings }),
		);
		const second = envelope(
			handleListPageObjects(ws, { limit: 100, offset: 0 }, { warnings }),
		);
		const shown = (first.meta?.warnings ?? []) as Array<
			Record<string, unknown>
		>;
		const repeat = (second.meta?.warnings ?? []) as Array<
			Record<string, unknown>
		>;
		// Unconditional: the fixture has no playwright config, so
		// `playwright-config-not-found` is always there to de-duplicate. A
		// conditional skip here would pass by doing nothing the day it stopped.
		expect(shown.length).toBeGreaterThan(0);
		expect(shown[0]).toHaveProperty("message");
		expect(repeat[0]).not.toHaveProperty("message");
		expect(repeat[0]).toHaveProperty("repeat");
	});

	it("behaves as it did before sessions existed when called without one", () => {
		const out = envelope(
			handleListPageObjects(makeWorkspace(APP), { limit: 100, offset: 0 }),
		);
		expect(out.ok).toBe(true);
	});
});
