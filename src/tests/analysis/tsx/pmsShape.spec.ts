import { describe, expect, it } from "vitest";
import { staticId } from "../../../analysis";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import type { UiNode } from "../../../analysis/types";
import { makeWorkspace } from "../helpers/inMemory";

/**
 * The field-test shape, in miniature.
 *
 * A production React screen wrapped every section in a design-system component,
 * declared some of its content in `useMemo` variables, handed some through
 * props, and wrote one attribute from a prop nobody passed. Against that page
 * the walk reported 8 of 82 rendered ids — about 10 % recall — and called the
 * result `fidelity: "full"`.
 *
 * Each gap gets its own focused suite; this one exists to keep them working
 * *together*, because that is how they occur.
 */

const FILES = {
	"src/Page.tsx": [
		'import { useMemo } from "react";',
		'import { Gapped, Modal } from "@ext/ui";',
		'import { Row } from "./Row";',
		"",
		'export function Header() { return <h1 data-testid="Head" />; }',
		"",
		"export function Page({ dataTid }: { dataTid?: string }) {",
		'  const info = useMemo(() => <div data-testid="Info" />, []);',
		"  return (",
		"    <Gapped>",
		"      <Header />",
		"      <Row />",
		'      <Modal caption={<span data-testid="Cap" />} />',
		"      {info}",
		"      <div data-testid={dataTid} />",
		"    </Gapped>",
		"  );",
		"}",
	].join("\n"),
	"src/Row.tsx": [
		"export function Row({ dataTid }: { dataTid?: string }) {",
		'  return <tr data-testid={dataTid || "Row"} />;',
		"}",
	].join("\n"),
};

function flatten(nodes: UiNode[]): UiNode[] {
	return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function staticIds(values: Array<string | undefined>): string[] {
	return [
		...new Set(values.filter((value): value is string => !!value)),
	].sort();
}

describe("composition-heavy page — every gap at once", () => {
	const tree = buildTestIdTree(makeWorkspace(FILES), {
		entry: "src/Page.tsx",
		entryComponent: "Page",
	});
	const nodes = flatten(tree.roots);
	const byId = (id: string): UiNode | undefined =>
		nodes.find((node) => staticId(node.testId) === id);

	it("roots at the requested component, not the file's first", () => {
		expect(tree.roots[0].tag).toBe("Gapped");
		expect(tree.roots[0].component).toBe("Page");
		// `Header` is declared first in the file and would have been the root.
		expect(tree.roots).toHaveLength(1);
	});

	it("keeps every child the unreadable wrapper was handed", () => {
		expect(tree.roots[0].unresolved).toEqual({ reason: "external-module" });
		for (const id of ["Head", "Cap", "Info", "Row"]) {
			expect(
				byId(id),
				`"${id}" must survive the Gapped boundary`,
			).toBeDefined();
		}
	});

	it("marks the caller's own JSX as unproven in placement, not missing", () => {
		// Header is a slot child of Gapped; its own rendered <h1> is not.
		const header = nodes.find((node) => node.tag === "Header");
		expect(header?.placement).toEqual({ kind: "slot", name: "children" });
		expect(byId("Head")?.placement).toBeUndefined();
		expect(byId("Cap")?.placement).toEqual({ kind: "prop", name: "caption" });
		expect(byId("Info")?.placement).toEqual({ kind: "slot", name: "children" });
	});

	it("resolves the row's fallback id instead of reporting it dynamic", () => {
		const row = byId("Row");
		expect(row?.tag).toBe("tr");
		expect(row?.testId).toMatchObject({ kind: "static", value: "Row" });
		expect(row?.viaDefault).toBe(true);
		expect(row?.viaProp).toBe("dataTid");
	});

	it("reports no id for the attribute the root's caller never filled", () => {
		// `Page` is the tree root, so its own `dataTid` is unknown rather than
		// absent — nothing inside the analysed tree calls it.
		const bare = nodes.find(
			(node) => node.tag === "div" && node.testId?.kind === "dynamic",
		);
		expect(bare?.testId?.raw).toBe("dataTid");
		expect(bare?.testIdAbsent).toBeUndefined();
		expect(staticIds(nodes.map((node) => staticId(node.testId)))).not.toContain(
			"dataTid",
		);
	});

	it("says the tree is partial and where the hole is", () => {
		expect(tree.fidelity).toBe("partial");
		expect(tree.stats.unresolvedByReason["external-module"]).toBeGreaterThan(0);
		expect(tree.fidelityReason).toContain("external-module");
	});

	it("puts every statically known id from the inventory into the tree", () => {
		// The 82-vs-8 invariant, in miniature: nothing the flat scan proved is
		// missing from the walked tree.
		const inTree = staticIds(nodes.map((node) => staticId(node.testId)));
		const inInventory = staticIds(
			tree.inventory.map((entry) =>
				entry.value.kind === "static" ? entry.value.value : undefined,
			),
		);
		expect(inTree).toEqual(inInventory);
		expect(inTree).toEqual(["Cap", "Head", "Info", "Row"]);
	});
});
