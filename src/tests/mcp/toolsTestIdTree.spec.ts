import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	callTool,
	closeAllClients,
	warningCodes,
	withProject,
} from "./helpers/mcpClient";

afterAll(closeAllClients);

describe("get_testid_tree over the transport", () => {
	it("treats followComponents: false as a caller choice, not a budget cut", async () => {
		await withProject(
			"ppo-not-followed-",
			{
				"src/Deep.tsx": [
					"export function Shell() {",
					'\treturn <div data-testid="ShellBox"><Middle /></div>;',
					"}",
					"",
					"export function Middle() {",
					'\treturn <section data-testid="MiddleBox" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const { isError, envelope } = await callTool(
					client,
					"get_testid_tree",
					{ component: "Shell", followComponents: false },
				);

				expect(isError).toBe(false);
				// It used to be faked as `depth: 1`, so the answer blamed a budget
				// that was never reached and reported the tree as truncated.
				expect(envelope.meta?.truncated).toBeUndefined();
				expect(envelope.meta?.fidelity).toBe("partial");
				expect(warningCodes(envelope)).not.toContain("depth-limit-reached");
				expect(warningCodes(envelope)).toContain("components-not-followed");
				expect(String(envelope.meta?.hint)).toContain("followComponents: true");
			},
		);
	}, 30_000);

	it("renders placement and each kind of hole distinctly in outline format", async () => {
		await withProject(
			"ppo-outline-labels-",
			{
				"src/Page.tsx": [
					'import { Gapped } from "@ext/ui";',
					"export function Page() {",
					"\treturn (",
					"\t\t<Gapped>",
					'\t\t\t<span data-testid="Slotted" />',
					"\t\t\t<Nested />",
					"\t\t</Gapped>",
					"\t);",
					"}",
					"",
					"export function Nested() {",
					'\treturn <b data-testid="Deep" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const passed = await callTool(client, "get_testid_tree", {
					component: "Page",
					format: "outline",
				});
				const text = String(passed.envelope.data);
				expect(text).toContain("slot");
				expect(text).toContain("external module");

				const stubbed = await callTool(client, "get_testid_tree", {
					component: "Page",
					format: "outline",
					depth: 1,
				});
				const stubbedText = String(stubbed.envelope.data);
				expect(stubbedText).toContain("depth limit");
				// Two different situations must not read as one `unresolved:` bucket.
				expect(stubbedText).not.toBe(text);
			},
		);
	}, 30_000);

	// `tree-partial` says where the *walk* stopped, in terms of `roots`. A
	// `testId` lookup ships occurrences read off the flat inventory, which is
	// complete in every fidelity mode, so the caveat landed on the one part of
	// the analysis it cannot apply to.
	it("does not caveat a testId lookup with the shape of a tree it did not return", async () => {
		await withProject(
			"ppo-lookup-warnings-",
			{
				"src/App.tsx": [
					'import { Gapped } from "@ext/ui";',
					"export function App() {",
					'\treturn <Gapped><span data-testid="Slotted" /></Gapped>;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const codes = (envelope: { meta?: Record<string, unknown> }) =>
					((envelope.meta?.warnings ?? []) as Array<{ code: string }>).map(
						(warning) => warning.code,
					);

				// The tree really is partial: the wrapper is an unresolvable module.
				const tree = await callTool(client, "get_testid_tree", {
					component: "App",
				});
				expect(tree.envelope.meta?.fidelity).toBe("partial");
				expect(codes(tree.envelope)).toContain("tree-partial");

				const lookup = await callTool(client, "get_testid_tree", {
					testId: "Slotted",
				});
				expect(lookup.isError).toBe(false);
				expect(codes(lookup.envelope)).not.toContain("tree-partial");

				// Same reasoning, one layer down: coverage ships no roots either.
				const coverage = await callTool(client, "map_coverage", {
					buckets: [],
				});
				expect(codes(coverage.envelope)).not.toContain("tree-partial");
			},
		);
	}, 30_000);

	// The tree carries every branch of a static choice, and outline is the format
	// an agent actually reads. Printing only the first branch there said
	// `data-testid={big ? "Main" : "Alt"}` renders `Main`, so a correct selector
	// for `Alt` read as invented — the same disagreement between the tree and the
	// flat inventory that `testIdAlternatives` exists to close.
	it("shows every branch of a static choice in outline format", async () => {
		await withProject(
			"ppo-outline-alternatives-",
			{
				"src/App.tsx": [
					"export function App({ big }: { big: boolean }) {",
					'\treturn <div data-testid={big ? "Main" : "Alt"} />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const outline = await callTool(client, "get_testid_tree", {
					component: "App",
					format: "outline",
				});
				const text = String(outline.envelope.data);
				expect(text).toContain("Main");
				expect(text).toContain("Alt");

				const json = await callTool(client, "get_testid_tree", {
					component: "App",
					format: "json",
				});
				expect(JSON.stringify(json.envelope.data)).toContain(
					"testIdAlternatives",
				);
			},
		);
	}, 30_000);

	it("says the walk was depth-limited rather than implying the tree is whole", async () => {
		const files = {
			"src/Deep.tsx": [
				"export function Shell() {",
				'\treturn <div data-testid="ShellBox"><Middle /></div>;',
				"}",
				"",
				"export function Middle() {",
				'\treturn <section data-testid="MiddleBox"><Leaf /></section>;',
				"}",
				"",
				"export function Leaf() {",
				'\treturn <span data-testid="LeafBox" />;',
				"}",
				"",
			].join("\n"),
		};

		await withProject("ppo-depth-hint-", files, async (client) => {
			const shallow = await callTool(client, "get_testid_tree", {
				component: "Shell",
				depth: 1,
			});

			expect(shallow.isError).toBe(false);
			expect(shallow.envelope.meta?.fidelity).toBe("partial");
			expect(shallow.envelope.meta?.truncated).toBe(true);
			expect(String(shallow.envelope.meta?.hint)).toContain("depth");

			// The hint has to actually work.
			const deep = await callTool(client, "get_testid_tree", {
				component: "Shell",
				depth: 3,
			});
			expect(deep.envelope.meta?.fidelity).toBe("full");
			expect(JSON.stringify(deep.envelope.data)).toContain("LeafBox");
		});
	}, 30_000);

	it("counts stats over the returned tree, not the whole scan", async () => {
		await withProject(
			"ppo-rooted-stats-",
			{
				"src/Nested.tsx": [
					"export function Outer() {",
					'\treturn <div data-testid="OuterBox"><Inner /></div>;',
					"}",
					"",
					"export function Inner() {",
					'\treturn <span data-testid="InnerBox" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				type Payload = {
					roots: Array<{ testId?: unknown; children: unknown[] }>;
					stats: { nodes: number; testIds: number };
				};
				const countNodes = (nodes: Payload["roots"]): number =>
					nodes.reduce(
						(total, node) =>
							total + 1 + countNodes(node.children as Payload["roots"]),
						0,
					);

				const whole = await callTool(client, "get_testid_tree", {
					file: "src/Nested.tsx",
					format: "json",
				});
				const wholeData = whole.envelope.data as Payload;
				expect(wholeData.stats.nodes).toBe(countNodes(wholeData.roots));
				expect(wholeData.stats.testIds).toBe(2);
				expect(whole.envelope.meta?.scanned).toBe(1);

				const rooted = await callTool(client, "get_testid_tree", {
					component: "Inner",
					format: "json",
				});
				const rootedData = rooted.envelope.data as Payload;
				expect(rootedData.roots[0]).toMatchObject({ tag: "span" });
				expect(rootedData.stats.nodes).toBe(countNodes(rootedData.roots));
				expect(
					rootedData.stats.testIds,
					"OuterBox is outside the returned subtree and must not be counted",
				).toBe(1);
			},
		);
	}, 30_000);

	// The breakdown existed only as prose, inside `fidelityReason` and the
	// `tree-partial` warning. A caller that wants to branch on where the holes
	// are had to parse an English sentence.
	it("ships the unresolved breakdown as counts, agreeing with the prose", async () => {
		await withProject(
			"ppo-unresolved-stats-",
			{
				"src/Deep.tsx": [
					"export function Shell() {",
					'\treturn <div data-testid="ShellBox"><Middle /></div>;',
					"}",
					"",
					"export function Middle() {",
					'\treturn <section data-testid="MiddleBox" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const partial = await callTool(client, "get_testid_tree", {
					component: "Shell",
					followComponents: false,
					format: "json",
				});
				const stats = (
					partial.envelope.data as { stats: Record<string, unknown> }
				).stats;
				expect(stats.unresolved).toBe(1);
				expect(stats.unresolvedByReason).toEqual({ "not-followed": 1 });
				// One source of truth: the sentence is rendered from these counts.
				expect(String(partial.envelope.meta?.fidelityReason)).toContain(
					"not-followed ×1",
				);

				// A complete tree says so with a zero and no breakdown at all, rather
				// than with an empty object nobody has to read.
				const whole = await callTool(client, "get_testid_tree", {
					component: "Shell",
					format: "json",
				});
				const wholeStats = (
					whole.envelope.data as { stats: Record<string, unknown> }
				).stats;
				expect(whole.envelope.meta?.fidelity).toBe("full");
				expect(wholeStats.unresolved).toBe(0);
				expect(wholeStats.unresolvedByReason).toBeUndefined();
			},
		);
	}, 30_000);

	// A typo'd `file` used to be discarded in silence: the entry matched nothing,
	// the walk fell back to a flat inventory of the whole scan, and a real app
	// answered `too_large` with advice to scope the call with `file` — which the
	// caller had just done. An agent loops there.
	it("rejects a typo'd get_testid_tree file with ranked suggestions", async () => {
		await withProject(
			"ppo-testid-file-typo-",
			{
				"src/components/GuestItem/GuestItemInfo.tsx": [
					"export function GuestItemInfo() {",
					'\treturn <div data-testid="GuestItemBox"><span data-testid="GuestName" /></div>;',
					"}",
					"",
				].join("\n"),
				"src/App.tsx": [
					'import { GuestItemInfo } from "./components/GuestItem/GuestItemInfo";',
					"export function App() {",
					'\treturn <main data-testid="AppRoot"><GuestItemInfo /></main>;',
					"}",
					"",
				].join("\n"),
			},
			async (client, root) => {
				const typo = await callTool(client, "get_testid_tree", {
					file: "src/components/GuestItem/GuestItemInf.tsx",
				});

				expect(typo.isError).toBe(true);
				expect(typo.envelope.error?.code).toBe("file_not_found");
				expect(typo.envelope.error?.suggestions).toContain(
					"src/components/GuestItem/GuestItemInfo.tsx",
				);
				expect(
					JSON.stringify(typo.envelope),
					"a scope that matched nothing must not ship the whole-app inventory",
				).not.toContain("AppRoot");

				// The suggested path has to work, and has to still scope the walk.
				const good = await callTool(client, "get_testid_tree", {
					file: "src/components/GuestItem/GuestItemInfo.tsx",
				});
				expect(good.isError).toBe(false);
				const serialized = JSON.stringify(good.envelope.data);
				expect(serialized).toContain("GuestName");
				expect(serialized).not.toContain("AppRoot");

				// Agents paste the path their editor shows them, here too.
				const absolute = await callTool(client, "get_testid_tree", {
					file: path.join(
						root,
						"src",
						"components",
						"GuestItem",
						"GuestItemInfo.tsx",
					),
				});
				expect(absolute.isError).toBe(false);
				expect(String(absolute.envelope.meta?.note)).toContain(
					"src/components/GuestItem/GuestItemInfo.tsx",
				);
			},
		);
	}, 30_000);
});
