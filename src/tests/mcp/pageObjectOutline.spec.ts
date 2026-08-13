import { describe, expect, it } from "vitest";
import type {
	Diagnostic,
	MemberNode,
	MethodInfo,
	PageObjectNode,
	PageObjectTree,
	SelectorInfo,
} from "../../analysis";
import { renderPageObjectOutline } from "../../mcp/outline";

/**
 * The default response format for `get_page_object_tree`.
 *
 * `schemas.ts` defaults `format` to `"outline"`, so this renderer is what an
 * agent reads unless it deliberately opts into JSON — and until now it was
 * covered only by substring greps through a booted client, while its twin
 * `renderTestIdOutline` had seven direct tests in the same file.
 *
 * Built from literal nodes for the same reason that one is: every branch here
 * is a decision about *wording*, and reaching one through a real repository
 * means authoring a fixture whose only purpose is to make the analyser produce
 * a shape. A reader checking whether "(not expanded: depth limit)" is right
 * should not have to build a nine-deep page-object graph first.
 */

function member(
	name: string,
	result: MemberNode["result"],
	selector: Partial<SelectorInfo> = {},
): MemberNode {
	return {
		name,
		loc: { file: "src/Page.ts", line: 2 },
		visibility: "public",
		selector: {
			kind: "testId",
			decorator: "Selector",
			testId: name,
			dynamic: false,
			raw: `@Selector("${name}")`,
			...selector,
		} as SelectorInfo,
		result,
	};
}

function def(
	className: string,
	overrides: Partial<PageObjectNode> = {},
): PageObjectNode {
	return {
		id: `src/${className}.ts#${className}`,
		className,
		file: `src/${className}.ts`,
		loc: { file: `src/${className}.ts`, line: 1 },
		hostKind: "rootPageObject",
		scope: "root-selector",
		extendsChain: ["RootPageObject"],
		inheritedApi: "RootPageObject",
		members: [],
		methods: [],
		expanded: true,
		...overrides,
	};
}

function treeOf(
	defs: PageObjectNode[],
	warnings: Diagnostic[] = [],
): PageObjectTree {
	return {
		schemaVersion: 1,
		projectRoot: "/repo",
		testIdAttribute: "data-testid",
		testIdAttributeSource: "default",
		root: defs[0]?.id ?? "",
		defs: Object.fromEntries(defs.map((one) => [one.id, one])),
		warnings,
		stats: {
			defs: defs.length,
			members: 0,
			methods: 0,
			dynamic: 0,
			parseMs: 0,
		},
	};
}

const warning = (code: string): Diagnostic =>
	({ code, severity: "warning", message: code }) as Diagnostic;

const method = (overrides: Partial<MethodInfo>): MethodInfo =>
	({
		name: "apply",
		kind: "method",
		signature: "apply(): Promise<void>",
		visibility: "public",
		isStatic: false,
		...overrides,
	}) as MethodInfo;

describe("renderPageObjectOutline — the header line", () => {
	it("carries class, host kind, root selector and file", () => {
		const outline = renderPageObjectOutline(
			treeOf([
				def("CheckoutPage", {
					rootSelector: {
						kind: "testId",
						decorator: "RootSelector",
						testId: "Checkout",
						dynamic: false,
						raw: "@RootSelector",
					} as SelectorInfo,
				}),
			]),
		);
		expect(outline).toContain("CheckoutPage (rootPageObject)");
		expect(outline).toContain('@testId "Checkout"');
		expect(outline).toContain("src/CheckoutPage.ts");
	});

	it("names a fixture binding when one exists", () => {
		// The one fact that decides the first line of the test: with a fixture the
		// reader takes an argument, without one they construct the class.
		const withFixture = renderPageObjectOutline(
			treeOf([
				def("CheckoutPage", {
					fixtures: [
						{ name: "checkoutPage", file: "e2e/fixtures.ts" },
					] as PageObjectNode["fixtures"],
				}),
			]),
		);
		expect(withFixture).toContain("fixture: checkoutPage");
		expect(
			renderPageObjectOutline(treeOf([def("CheckoutPage")])),
		).not.toContain("fixture:");
	});
});

describe("renderPageObjectOutline — member lines", () => {
	it("labels every result kind", () => {
		const outline = renderPageObjectOutline(
			treeOf([
				def("Page", {
					members: [
						member("Plain", { kind: "locator" }),
						member("Panel", {
							kind: "pageObject",
							ref: null,
							className: "Panel",
						}),
						member("Rows", {
							kind: "list",
							listClassName: "ListPageObject",
							listRef: null,
							itemClassName: "RowControl",
							itemRef: null,
						}),
						member("Named", {
							kind: "control",
							ref: null,
							className: "ButtonControl",
						}),
						member("Mystery", {
							kind: "unknown",
							dynamic: true,
							source: "makeIt()",
						}),
					],
				}),
			]),
		);
		expect(outline).toContain("Plain -> Locator");
		expect(outline).toContain("Panel -> Panel");
		expect(outline).toContain("Rows -> ListPageObject<RowControl>");
		expect(outline).toContain("Named -> ButtonControl");
		expect(outline).toContain("Mystery -> unknown");
	});

	it("falls back to PageObject for a list with no item class", () => {
		const outline = renderPageObjectOutline(
			treeOf([
				def("Page", {
					members: [
						member("Rows", {
							kind: "list",
							listClassName: "ListPageObject",
							listRef: null,
							itemClassName: null,
							itemRef: null,
						}),
					],
				}),
			]),
		);
		expect(outline).toContain("Rows -> ListPageObject<PageObject>");
	});

	it("marks a member the engine calls dynamic, by all three routes", () => {
		const outline = renderPageObjectOutline(
			treeOf([
				def("Page", {
					members: [
						member("BySelector", { kind: "locator" }, { dynamic: true }),
						member("ByUnknown", {
							kind: "unknown",
							dynamic: true,
							source: "makeIt()",
						}),
						member("ByControl", {
							kind: "control",
							ref: null,
							className: "X",
							dynamic: true,
						}),
						member("Static", { kind: "locator" }),
					],
				}),
			]),
		);
		// The predicate is the engine's `isDynamicMember`, imported rather than
		// mirrored — a resolved-looking label can still be a guess.
		expect(outline).toContain("BySelector -> Locator");
		for (const name of ["BySelector", "ByUnknown", "ByControl"]) {
			const line = outline.split("\n").find((one) => one.includes(name));
			expect(line, name).toContain("[dynamic]");
		}
		const stable = outline.split("\n").find((one) => one.includes("Static"));
		expect(stable).not.toContain("[dynamic]");
	});

	it("renders each selector spelling", () => {
		const outline = renderPageObjectOutline(
			treeOf([
				def("Page", {
					members: [
						member("Self", { kind: "locator" }, { kind: "self" }),
						member("Masked", { kind: "locator" }, {
							kind: "testIdPattern",
							pattern: { source: "Row_.*", flags: "" },
						} as Partial<SelectorInfo>),
						member("MaskedRaw", { kind: "locator" }, {
							kind: "testIdPattern",
							pattern: undefined,
							raw: "@ListSelector(mask)",
						} as Partial<SelectorInfo>),
						member("Role", { kind: "locator" }, {
							kind: "role",
							role: "button",
						} as Partial<SelectorInfo>),
						member(
							"Custom",
							{ kind: "locator" },
							{ kind: "custom", raw: "p => p.locator('x')" },
						),
						member("Labelled", { kind: "locator" }, {
							kind: "label",
							text: "Email",
						} as Partial<SelectorInfo>),
					],
				}),
			]),
		);
		expect(outline).toContain("@self");
		expect(outline).toContain("@testIdPattern /Row_.*/");
		expect(outline).toContain("@testIdPattern @ListSelector(mask)");
		expect(outline).toContain('@role "button"');
		expect(outline).toContain("@custom p => p.locator('x')");
		// The default arm: any other `getBy*` kind renders as its own name.
		expect(outline).toContain('@label "Email"');
	});
});

describe("renderPageObjectOutline — refs and recursion", () => {
	const child = def("Panel", { hostKind: "fragment", className: "Panel" });
	const parent = (memberRef: string) =>
		def("Page", {
			members: [
				member("Side", {
					kind: "pageObject",
					ref: memberRef,
					className: "Panel",
				}),
			],
		});

	it("expands a referenced definition underneath its member", () => {
		const outline = renderPageObjectOutline(treeOf([parent(child.id), child]));
		expect(outline).toContain("Side -> Panel");
		expect(outline).toContain("Panel (fragment)");
	});

	it("says why a ref has no definition, and says it three ways", () => {
		const missing = "src/Gone.ts#Gone";

		// Nothing to explain it: the class genuinely did not resolve.
		expect(renderPageObjectOutline(treeOf([parent(missing)]))).toContain(
			"(unresolved)",
		);

		// The owner hit the depth limit, so the class resolves fine and the walk
		// simply stopped — a reader told "unresolved" goes hunting a broken import.
		const depthLimited = parent(missing);
		depthLimited.warnings = [warning("depth-limit-reached")];
		expect(renderPageObjectOutline(treeOf([depthLimited]))).toContain(
			"(not expanded: depth limit)",
		);

		// Budget is a whole-tree fact, so it lives on the tree's warnings.
		expect(
			renderPageObjectOutline(
				treeOf([parent(missing)], [warning("node-budget-reached")]),
			),
		).toContain("(not expanded: node budget)");
	});

	it("prints a repeat as a back-reference instead of recursing", () => {
		const selfRef = def("Page", {
			members: [
				member("Me", {
					kind: "pageObject",
					ref: "src/Page.ts#Page",
					className: "Page",
				}),
			],
		});
		const outline = renderPageObjectOutline(treeOf([selfRef]));
		expect(outline).toContain("Page (see above)");
		// Terminated rather than recursed: the header appears once.
		expect(
			outline.split("\n").filter((l) => l.includes("(rootPageObject)")),
		).toHaveLength(1);
	});

	it("skips an external stub rather than printing an empty definition", () => {
		const external = def("ListPageObject", {
			hostKind: "fragment",
			external: true,
		});
		const outline = renderPageObjectOutline(
			treeOf([
				def("Page", {
					members: [
						member("Rows", {
							kind: "list",
							listClassName: "ListPageObject",
							listRef: external.id,
							itemClassName: null,
							itemRef: null,
						}),
					],
				}),
				external,
			]),
		);
		expect(outline).toContain("Rows -> ListPageObject<PageObject>");
		expect(outline).not.toContain("ListPageObject (fragment)");
	});
});

describe("renderPageObjectOutline — methods", () => {
	it("splits methods from accessors, because they are called differently", () => {
		// `await p.apply()` against `p.total`. One combined line made a getter look
		// like a method, which is a TypeError an agent only finds at run time.
		const outline = renderPageObjectOutline(
			treeOf([
				def("Page", {
					methods: [
						method({ name: "apply", kind: "method" }),
						method({
							name: "total",
							kind: "getter",
							signature: "total: number",
						}),
					],
				}),
			]),
		);
		expect(outline).toContain("methods: apply(): Promise<void>");
		expect(outline).toContain("accessors: total: number");
	});

	it("marks inheritance, visibility and staticness", () => {
		const outline = renderPageObjectOutline(
			treeOf([
				def("Page", {
					methods: [
						method({ inherited: true, declaredIn: "BasePage" }),
						method({ name: "bare", signature: "bare()", inherited: true }),
						method({
							name: "guarded",
							signature: "guarded()",
							visibility: "protected",
						}),
						method({ name: "make", signature: "make()", isStatic: true }),
					],
				}),
			]),
		);
		expect(outline).toContain("[inherited: BasePage]");
		expect(outline).toContain("bare() [inherited]");
		expect(outline).toContain("guarded() [protected]");
		expect(outline).toContain("make() [static]");
	});

	it("omits both lines when a class declares neither", () => {
		const outline = renderPageObjectOutline(treeOf([def("Page")]));
		expect(outline).not.toContain("methods:");
		expect(outline).not.toContain("accessors:");
	});
});
