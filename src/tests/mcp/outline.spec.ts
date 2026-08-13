import { describe, expect, it } from "vitest";
import type { TestIdTree, UiNode } from "../../analysis";
import { renderTestIdOutline } from "../../mcp/outline";

/**
 * The outline is the format the instructions tell an agent to prefer, so it is
 * where payload size costs something real. These tests pin the three reductions
 * that make it cheap, and — more importantly — the limits on them: a reduction
 * that dropped an id or a hole would be trading the tool's whole purpose for
 * bytes.
 */

function node(partial: Partial<UiNode> & { tag: string }): UiNode {
	return {
		nodeType: "element",
		file: "src/App.tsx",
		loc: { file: partial.file ?? "src/App.tsx", line: 1 },
		component: "App",
		children: [],
		...partial,
	};
}

function id(value: string): UiNode["testId"] {
	return { kind: "static", value, raw: `"${value}"` };
}

function treeOf(roots: UiNode[]): TestIdTree {
	return {
		schemaVersion: 1,
		scanner: "jsx",
		attribute: "data-testid",
		attributeSource: "default",
		fidelity: "full",
		roots,
		components: {},
		inventory: [],
		externalModules: [],
		externalModuleCount: 0,
		linkedExternalModules: [],
		linkedExternalModuleCount: 0,
		warnings: [],
		stats: {
			files: 1,
			occurrences: 0,
			dynamic: 0,
			parseMs: 0,
			externalComponentTags: 0,
			nodes: 0,
			unresolved: 0,
			unresolvedByReason: {},
			slots: 0,
		},
	};
}

describe("renderTestIdOutline — reductions", () => {
	it("prints the file only where it changes", () => {
		const outline = renderTestIdOutline(
			treeOf([
				node({
					tag: "div",
					testId: id("Root"),
					loc: { file: "src/App.tsx", line: 1 },
					children: [
						node({
							tag: "span",
							testId: id("Same"),
							loc: { file: "src/App.tsx", line: 5 },
						}),
						node({
							tag: "b",
							testId: id("Other"),
							file: "src/Other.tsx",
							loc: { file: "src/Other.tsx", line: 9 },
						}),
					],
				}),
			]),
		);

		const lines = outline.split("\n");
		expect(lines[0]).toContain("src/App.tsx:1");
		// Same file as its parent: the path is inherited, the line still shown.
		expect(lines[1]).toContain(":5");
		expect(lines[1]).not.toContain("src/App.tsx");
		// A different file must always name itself.
		expect(lines[2]).toContain("src/Other.tsx:9");
	});

	it("drops nodes with no id and no hole, keeping their descendants", () => {
		const outline = renderTestIdOutline(
			treeOf([
				node({
					tag: "root",
					testId: id("Root"),
					children: [
						node({
							tag: "Provider",
							children: [
								node({
									tag: "Layout",
									children: [node({ tag: "input", testId: id("Deep") })],
								}),
							],
						}),
					],
				}),
			]),
		);

		expect(outline).not.toContain("Provider");
		expect(outline).not.toContain("Layout");
		// The id survives, promoted to where the structure used to be.
		expect(outline).toContain("Deep");
	});

	it("never drops a hole, however empty the node around it", () => {
		const outline = renderTestIdOutline(
			treeOf([
				node({
					tag: "root",
					testId: id("Root"),
					children: [
						node({
							tag: "Widget",
							nodeType: "unresolved",
							unresolved: { reason: "external-module" },
						}),
					],
				}),
			]),
		);

		expect(outline).toContain("Widget");
		expect(outline).toContain("external module");
	});

	it("aggregates a run of sibling holes but keeps reason and count", () => {
		const holes = ["A", "B", "C", "D"].map((tag) =>
			node({
				tag,
				nodeType: "unresolved",
				unresolved: { reason: "external-module" },
			}),
		);
		const outline = renderTestIdOutline(
			treeOf([node({ tag: "root", testId: id("Root"), children: holes })]),
		);

		expect(outline).toContain("4 boundaries not expanded");
		expect(outline).toContain("external module: A, B, C, D");
	});

	it("leaves two holes alone — a group of two is not noise", () => {
		const holes = ["A", "B"].map((tag) =>
			node({
				tag,
				nodeType: "unresolved",
				unresolved: { reason: "external-module" },
			}),
		);
		const outline = renderTestIdOutline(
			treeOf([node({ tag: "root", testId: id("Root"), children: holes })]),
		);

		expect(outline).not.toContain("boundaries not expanded");
		expect(outline.split("\n")).toHaveLength(3);
	});

	it("collapses a second identical subtree to a back-reference", () => {
		const contents = (): UiNode[] => [
			node({
				tag: "h1",
				testId: id("Title"),
				file: "src/Modal.tsx",
				loc: { file: "src/Modal.tsx", line: 10 },
			}),
			node({
				tag: "button",
				testId: id("Close"),
				file: "src/Modal.tsx",
				loc: { file: "src/Modal.tsx", line: 11 },
			}),
		];
		const outline = renderTestIdOutline(
			treeOf([
				node({
					tag: "root",
					testId: id("Root"),
					children: [
						node({
							tag: "Modal",
							file: "src/Modal.tsx",
							loc: { file: "src/Modal.tsx", line: 2 },
							testId: id("First"),
							children: contents(),
						}),
						node({
							tag: "Modal",
							file: "src/Modal.tsx",
							loc: { file: "src/Modal.tsx", line: 3 },
							testId: id("Second"),
							children: contents(),
						}),
					],
				}),
			]),
		);

		// Printed once...
		expect(outline.match(/Title/g)).toHaveLength(1);
		expect(outline).toContain("(contents as at src/Modal.tsx:10)");
		// ...but both call sites are still there, with their own ids.
		expect(outline).toContain("First");
		expect(outline).toContain("Second");
	});

	it("does not back-reference a single line of contents", () => {
		const only = (): UiNode[] => [node({ tag: "h1", testId: id("Title") })];
		const outline = renderTestIdOutline(
			treeOf([
				node({
					tag: "root",
					testId: id("Root"),
					children: [
						node({ tag: "A", testId: id("A"), children: only() }),
						node({ tag: "B", testId: id("B"), children: only() }),
					],
				}),
			]),
		);

		// Finding one line elsewhere costs the reader more than the line itself.
		expect(outline).not.toContain("contents as at");
		expect(outline.match(/Title/g)).toHaveLength(2);
	});
});
