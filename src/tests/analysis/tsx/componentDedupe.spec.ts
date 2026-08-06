import { describe, expect, it } from "vitest";
import type { TestIdTreeOptions } from "../../../analysis/tsx/tree";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import type { UiNode } from "../../../analysis/types";
import { makeWorkspace } from "../helpers/inMemory";

const BOOTSTRAP = {
	"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
};

function flatten(nodes: UiNode[]): UiNode[] {
	return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function treeFor(files: Record<string, string>, options?: TestIdTreeOptions) {
	const tree = buildTestIdTree(
		makeWorkspace({ ...BOOTSTRAP, ...files }),
		options,
	);
	return { tree, nodes: flatten(tree.roots) };
}

/** Every render site of one component tag, in document order. */
function sitesOf(nodes: UiNode[], tag: string): UiNode[] {
	return nodes.filter(
		(node) => node.nodeType === "component" && node.tag === tag,
	);
}

const BADGE = {
	"src/Badge.tsx": [
		"export default function Badge() {",
		'  return <span data-testid="Badge" />;',
		"}",
	].join("\n"),
};

describe("cross-site component de-duplication", () => {
	it("expands the first site and references it from the second", () => {
		const { nodes } = treeFor({
			...BADGE,
			"src/App.tsx": [
				'import Badge from "./Badge";',
				"export default function App() {",
				"  return (",
				'    <div data-testid="Root">',
				"      <Badge />",
				'      <section data-testid="Section">',
				"        <Badge />",
				"      </section>",
				"    </div>",
				"  );",
				"}",
			].join("\n"),
		});

		const [first, second] = sitesOf(nodes, "Badge");
		expect(first.children.map((child) => child.testId?.value)).toEqual([
			"Badge",
		]);
		expect(first.expandedAt).toBeUndefined();

		expect(second.children).toEqual([]);
		expect(second.expandedAt).toEqual(first.loc);
		// The reference still describes its own site.
		expect(second.componentRef).toBe(first.componentRef);
		expect(second.loc).not.toEqual(first.loc);
	});

	it("keeps the referencing site's own flags and test id", () => {
		const { nodes } = treeFor({
			...BADGE,
			"src/App.tsx": [
				'import Badge from "./Badge";',
				"export default function App({ show }: { show: boolean }) {",
				"  return (",
				"    <div>",
				"      <Badge />",
				"      {show && <Badge />}",
				"      {[1, 2].map((n) => (",
				"        <Badge key={n} />",
				"      ))}",
				"    </div>",
				"  );",
				"}",
			].join("\n"),
		});

		const [plain, conditional, repeated] = sitesOf(nodes, "Badge");
		expect(plain.expandedAt).toBeUndefined();
		// A conditional or repeated site inherits a different context into the
		// subtree, so it is a different expansion and gets expanded on its own.
		expect(conditional.conditional).toBe(true);
		expect(conditional.expandedAt).toBeUndefined();
		expect(conditional.children).toHaveLength(1);
		expect(repeated.repeated).toBe(true);
		expect(repeated.expandedAt).toBeUndefined();
		expect(repeated.children).toHaveLength(1);
	});

	it("does not de-duplicate sites that bind different prop values", () => {
		const { nodes, tree } = treeFor({
			"src/Badge.tsx": [
				"export default function Badge({ testId }: { testId: string }) {",
				"  return <span data-testid={testId} />;",
				"}",
			].join("\n"),
			"src/App.tsx": [
				'import Badge from "./Badge";',
				"export default function App() {",
				"  return (",
				"    <div>",
				'      <Badge testId="One" />',
				'      <Badge testId="Two" />',
				"    </div>",
				"  );",
				"}",
			].join("\n"),
		});

		const [first, second] = sitesOf(nodes, "Badge");
		expect(first.expandedAt).toBeUndefined();
		expect(second.expandedAt).toBeUndefined();
		expect(first.children[0]?.testId).toMatchObject({ value: "One" });
		expect(second.children[0]?.testId).toMatchObject({ value: "Two" });

		// Both bound values reach the inventory, from the one source location.
		const resolved = tree.inventory.filter(
			(occurrence) => occurrence.viaProp === "testId",
		);
		expect(resolved.map((occurrence) => occurrence.value.value).sort()).toEqual(
			["One", "Two"],
		);
	});

	it("de-duplicates sites that bind the same prop value", () => {
		const { nodes, tree } = treeFor({
			"src/Badge.tsx": [
				"export default function Badge({ testId }: { testId: string }) {",
				"  return <span data-testid={testId} />;",
				"}",
			].join("\n"),
			"src/App.tsx": [
				'import Badge from "./Badge";',
				"export default function App() {",
				"  return (",
				"    <div>",
				'      <Badge testId="Same" />',
				'      <Badge testId="Same" />',
				"    </div>",
				"  );",
				"}",
			].join("\n"),
		});

		const [first, second] = sitesOf(nodes, "Badge");
		expect(first.children[0]?.testId).toMatchObject({ value: "Same" });
		expect(second.children).toEqual([]);
		expect(second.expandedAt).toEqual(first.loc);

		// One source location bound to one value is one occurrence, whether or
		// not the tree collapsed the second site.
		const resolved = tree.inventory.filter(
			(occurrence) => occurrence.viaProp === "testId",
		);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].value).toMatchObject({ value: "Same" });
	});

	it("leaves the same-path recursion guard untouched", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Tree from "./Tree";',
				"export default function App() { return <Tree />; }",
			].join("\n"),
			"src/Tree.tsx": [
				"export default function Tree() {",
				'  return <div data-testid="Node"><Tree /></div>;',
				"}",
			].join("\n"),
		});

		const [outer, inner] = sitesOf(nodes, "Tree");
		expect(outer.repeated).toBeUndefined();
		expect(outer.children).toHaveLength(1);
		expect(inner.repeated).toBe(true);
		expect(inner.children).toEqual([]);
		// A recursion cut is not a reference to an earlier expansion.
		expect(inner.expandedAt).toBeUndefined();
	});

	it("never references an expansion that was itself cut short", () => {
		const { nodes } = treeFor({
			"src/App.tsx": [
				'import Cyclic from "./Cyclic";',
				'import Wrapper from "./Wrapper";',
				"export default function App() {",
				"  return <div><Cyclic /><Wrapper /></div>;",
				"}",
			].join("\n"),
			"src/Wrapper.tsx": [
				'import Cyclic from "./Cyclic";',
				"export default function Wrapper() {",
				'  return <p data-testid="Wrap"><Cyclic /></p>;',
				"}",
			].join("\n"),
			"src/Cyclic.tsx": [
				"export default function Cyclic() {",
				'  return <span data-testid="Cyc"><Cyclic /></span>;',
				"}",
			].join("\n"),
		});

		// The first Cyclic expansion contains a recursion cut, so its shape
		// depends on the ancestor path and must not be reused elsewhere.
		const sites = sitesOf(nodes, "Cyclic").filter(
			(node) => node.component !== "Cyclic",
		);
		expect(sites).toHaveLength(2);
		for (const site of sites) {
			expect(site.expandedAt).toBeUndefined();
			expect(site.children).toHaveLength(1);
		}
	});

	it("spends no depth budget on a reference", () => {
		const files = {
			...BADGE,
			"src/App.tsx": [
				'import Badge from "./Badge";',
				'import L1 from "./L1";',
				"export default function App() {",
				"  return <div><Badge /><L1 /></div>;",
				"}",
			].join("\n"),
			"src/L1.tsx": [
				'import L2 from "./L2";',
				"export default function L1() { return <L2 />; }",
			].join("\n"),
			"src/L2.tsx": [
				'import Badge from "./Badge";',
				"export default function L2() { return <Badge />; }",
			].join("\n"),
		};

		const { nodes, tree } = treeFor(files, { maxDepth: 3 });
		const [first, deep] = sitesOf(nodes, "Badge");
		expect(first.children).toHaveLength(1);
		// Without the reference this site would be a `depth-limit-reached` stub;
		// a reference expands nothing, so the depth limit does not apply and the
		// tree is not reported as truncated.
		expect(deep.expandedAt).toEqual(first.loc);
		expect(deep.unresolved).toBeUndefined();
		expect(tree.truncated).toBeUndefined();
	});

	// The memo covers the callee's own subtree. Content the *site* passed in is
	// not part of that subtree, so it stays out of the key — and a memo hit has
	// to emit it anyway, or the caller's own JSX vanishes at every site after
	// the first, which is the bug this whole cluster exists to remove.
	it("still reports a memoized site's own slot children", () => {
		const { nodes } = treeFor({
			"src/Card.tsx": [
				"export default function Card({ children }: { children?: unknown }) {",
				'  return <div data-testid="Card">{children as never}</div>;',
				"}",
			].join("\n"),
			"src/App.tsx": [
				'import Card from "./Card";',
				"export default function App() {",
				"  return (",
				"    <div>",
				'      <Card><span data-testid="A" /></Card>',
				'      <Card><span data-testid="B" /></Card>',
				"    </div>",
				"  );",
				"}",
			].join("\n"),
		});

		const [first, second] = sitesOf(nodes, "Card");
		expect(first.expandedAt).toBeUndefined();
		expect(second.expandedAt).toEqual(first.loc);
		expect(second.children).toHaveLength(1);
		expect(second.children[0].testId).toMatchObject({ value: "B" });
		expect(second.children[0].placement).toEqual({
			kind: "slot",
			name: "children",
		});
		// Differing children must not split the expansion: the callee's subtree
		// cannot depend on them.
		expect(first.children.filter((child) => !child.placement)).toHaveLength(1);
	});

	it("splits the expansion when one site passes a prop and the other does not", () => {
		const { nodes } = treeFor({
			"src/Row.tsx": [
				"export default function Row({ rowId }: { rowId?: string }) {",
				"  return <tr data-testid={rowId} />;",
				"}",
			].join("\n"),
			"src/App.tsx": [
				'import Row from "./Row";',
				"export default function App({ x }: { x: string }) {",
				"  return (",
				"    <table>",
				"      <Row rowId={x} />",
				"      <Row />",
				"    </table>",
				"  );",
				"}",
			].join("\n"),
		});

		const [bound, bare] = sitesOf(nodes, "Row");
		// Both sites bind nothing statically, so the old key collapsed them — and
		// then reported the second site's phantom id as the first site's dynamic
		// one.
		expect(bound.expandedAt).toBeUndefined();
		expect(bare.expandedAt).toBeUndefined();
		expect(bound.children[0].testId?.kind).toBe("dynamic");
		expect(bound.children[0].testIdAbsent).toBeUndefined();
		expect(bare.children[0].testId).toBeUndefined();
		expect(bare.children[0].testIdAbsent).toBe(true);
	});

	it("does not let a budget cut inside slot children poison the memo", () => {
		const { nodes } = treeFor({
			"src/Card.tsx": [
				"export default function Card({ children }: { children?: unknown }) {",
				'  return <div data-testid="Card">{children as never}</div>;',
				"}",
			].join("\n"),
			"src/App.tsx": [
				'import Card from "./Card";',
				"export default function App() {",
				"  return (",
				"    <div>",
				"      <Card>",
				'        <span data-testid="S1"><i data-testid="S2" /></span>',
				"      </Card>",
				"      <Card />",
				"    </div>",
				"  );",
				"}",
			].join("\n"),
		});

		// Both `Card` sites pass nothing as props, so they share an expansion key
		// even though only one of them passes children.
		const [first, second] = sitesOf(nodes, "Card");
		expect(first.expandedAt).toBeUndefined();
		expect(second.expandedAt).toEqual(first.loc);
		expect(second.children).toEqual([]);
	});

	it("keeps the inventory complete when sites are collapsed", () => {
		const { tree, nodes } = treeFor({
			...BADGE,
			"src/App.tsx": [
				'import Badge from "./Badge";',
				"export default function App() {",
				'  return <div data-testid="Root"><Badge /><Badge /></div>;',
				"}",
			].join("\n"),
		});

		expect(sitesOf(nodes, "Badge")[1].expandedAt).toBeDefined();
		// The inventory is scanned per file, so the collapsed subtree's ids are
		// still there exactly once each.
		expect(
			tree.inventory.map((occurrence) => occurrence.value.value).sort(),
		).toEqual(["Badge", "Root"]);
		expect(tree.stats.occurrences).toBe(tree.inventory.length);
	});
});
