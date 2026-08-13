import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, describe, expect, it } from "vitest";
import {
	callTool,
	closeAllClients,
	connect,
	exampleRoot,
	pageObjectSource,
	withProject,
} from "./helpers/mcpClient";

afterAll(closeAllClients);

describe("tree tools over the transport", () => {
	it("rejects a call with neither class nor file", async () => {
		const { client } = await connect(exampleRoot);
		const { isError, envelope } = await callTool(
			client,
			"get_page_object_tree",
			{},
		);

		expect(isError).toBe(true);
		expect(envelope.ok).toBe(false);
		expect(envelope.error?.code).toBe("invalid_input");
		expect(envelope.error?.hint).toContain("list_page_objects");
	}, 30_000);

	// Both discriminators have to run on this path. A typo is answered by edit
	// distance; a partial name is four edits away and is answered only by the
	// substring pass, which this tool did not have — so `class: "Checkout"` came
	// back with no suggestions while map_coverage answered the same question.
	it("reports class_not_found with suggestions for a typo and for a partial", async () => {
		const { client } = await connect(exampleRoot);

		const typo = await callTool(client, "get_page_object_tree", {
			class: "CheckouPage",
		});
		expect(typo.isError).toBe(true);
		expect(typo.envelope.error?.code).toBe("class_not_found");
		expect(typo.envelope.error?.hint).toContain("list_page_objects");
		expect(typo.envelope.error?.suggestions).toContain("CheckoutPage");

		const partial = await callTool(client, "get_page_object_tree", {
			class: "Checkout",
		});
		expect(partial.envelope.error?.code).toBe("class_not_found");
		expect(partial.envelope.error?.suggestions).toContain("CheckoutPage");
	}, 30_000);

	it("get_testid_tree surfaces the dynamic CartItem_ pattern", async () => {
		const { client } = await connect(exampleRoot);
		const { isError, envelope } = await callTool(client, "get_testid_tree", {
			file: "src/components/CheckoutPage.tsx",
		});

		expect(isError).toBe(false);
		expect(envelope.ok).toBe(true);
		const serialized = JSON.stringify(envelope.data);
		expect(serialized).toContain("CartItem_");
		expect(serialized).toContain("PromoCodeInput");
	}, 30_000);

	it("map_coverage reports role selectors as unverifiable, never dead", async () => {
		const { client } = await connect(exampleRoot);
		const { isError, envelope } = await callTool(client, "map_coverage", {});

		expect(isError).toBe(false);
		expect(envelope.ok).toBe(true);
		const data = envelope.data as {
			summary: Record<string, number>;
			nonTestIdSelectors: Array<{ kind: string }>;
			deadSelectors: unknown[];
			uncoveredTestIds: Array<{ id: string | null }>;
		};
		expect(data.summary).toBeDefined();
		expect(
			data.nonTestIdSelectors.some((selector) => selector.kind === "role"),
			"role selectors must land in nonTestIdSelectors",
		).toBe(true);
		expect(data.deadSelectors).toHaveLength(0);
	}, 30_000);

	it("sees files written between two tool calls without a restart", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "ppo-live-"));
		mkdirSync(path.join(projectRoot, "e2e"), { recursive: true });
		const write = (name: string) =>
			writeFileSync(
				path.join(projectRoot, "e2e", `${name}.ts`),
				pageObjectSource(name),
				"utf8",
			);
		const names = async (client: Client): Promise<string[]> => {
			const { envelope } = await callTool(client, "list_page_objects", {});
			expect(envelope.ok).toBe(true);
			return (envelope.data as Array<{ name: string }>)
				.map((item) => item.name)
				.sort();
		};

		try {
			write("FirstPage");
			const { client } = await connect(projectRoot);
			// Builds the workspace; `create` does not revalidate, so no re-glob has
			// happened yet.
			expect(await names(client)).toEqual(["FirstPage"]);

			write("SecondPage");
			// Not a race against the 1s new-file throttle: that window is measured
			// from the last re-glob, and this is the first one this workspace runs,
			// so it rescans regardless of elapsed time. Locked by "re-globs on the
			// first revalidate however young the workspace is" in workspace.spec.ts.
			expect(await names(client)).toEqual(["FirstPage", "SecondPage"]);
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
		}
	}, 30_000);

	it("roots get_testid_tree at the requested component, not the file's first", async () => {
		await withProject(
			"ppo-multi-component-",
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
				const { isError, envelope } = await callTool(
					client,
					"get_testid_tree",
					{
						component: "Inner",
						format: "json",
					},
				);

				expect(isError).toBe(false);
				const data = envelope.data as {
					roots: Array<{ tag: string; component: string }>;
				};
				// The tree is what `Inner` renders, exactly as `file` roots a file at
				// what its entry component renders — not a `<Inner/>` tag node lifted
				// out of somebody else's tree.
				expect(data.roots[0]).toMatchObject({
					tag: "span",
					component: "Inner",
				});
				// The engine roots where it is told, so there is no substitution left
				// to disclose, which is all `rootedAt` ever meant.
				expect(envelope.meta?.rootedAt).toBeUndefined();
				const serialized = JSON.stringify(data.roots);
				expect(serialized).toContain("InnerBox");
				expect(
					serialized,
					"Outer is the file's first component but was not the one requested",
				).not.toContain("OuterBox");
			},
		);
	}, 30_000);

	it("reports ambiguous_component when two files declare the requested name", async () => {
		await withProject(
			"ppo-duplicate-name-",
			{
				"src/ui/Button.tsx": [
					"export function Button() {",
					'\treturn <button data-testid="UiButton" />;',
					"}",
					"",
				].join("\n"),
				"src/legacy/Button.tsx": [
					"export function Button() {",
					'\treturn <button data-testid="LegacyButton" />;',
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const ambiguous = await callTool(client, "get_testid_tree", {
					component: "Button",
				});

				expect(ambiguous.isError).toBe(true);
				expect(ambiguous.envelope.error?.code).toBe("ambiguous_component");
				expect(
					ambiguous.envelope.error?.candidates,
					"both declaring files must be named, not silently one of them",
				).toEqual(["src/legacy/Button.tsx", "src/ui/Button.tsx"]);
				expect(ambiguous.envelope.error?.hint).toContain("file");

				// The hint has to actually work: `file` + `component` must resolve.
				const scoped = await callTool(client, "get_testid_tree", {
					component: "Button",
					file: "src/ui/Button.tsx",
				});

				expect(scoped.isError).toBe(false);
				const serialized = JSON.stringify(scoped.envelope.data);
				expect(serialized).toContain("UiButton");
				expect(serialized).not.toContain("LegacyButton");
			},
		);
	}, 30_000);

	it("roots a deeply nested component directly instead of asking for more depth", async () => {
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

		await withProject("ppo-depth-limit-", files, async (client) => {
			// Leaf renders two levels below the file's first component, but it is
			// also declared right there — so it is rooted directly and the depth
			// budget never enters into it.
			const shallow = await callTool(client, "get_testid_tree", {
				component: "Leaf",
				depth: 1,
				format: "json",
			});

			expect(shallow.isError).toBe(false);
			const data = shallow.envelope.data as {
				roots: Array<{ tag: string; component: string }>;
			};
			expect(data.roots[0]).toMatchObject({ tag: "span", component: "Leaf" });
			const serialized = JSON.stringify(data.roots);
			expect(serialized).toContain("LeafBox");
			expect(serialized).not.toContain("ShellBox");
			expect(shallow.envelope.meta?.fidelity).toBe("full");
			expect(shallow.envelope.meta?.truncated).toBeUndefined();
		});
	}, 30_000);
});
