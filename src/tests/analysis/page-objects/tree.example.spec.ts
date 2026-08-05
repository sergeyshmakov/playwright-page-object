import * as path from "node:path";
import { Project, ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import { buildPageObjectTree } from "../../../analysis/page-objects/tree";
import type { MemberNode } from "../../../analysis/types";
import { toPosix } from "../../../analysis/util/paths";
import { Workspace } from "../../../analysis/workspace";
import { EXAMPLE_ROOT, exampleWorkspace } from "../helpers/example";

function memberByName(members: MemberNode[], name: string): MemberNode {
	const member = members.find((candidate) => candidate.name === name);
	if (!member) {
		throw new Error(`no member "${name}"`);
	}
	return member;
}

describe("example/ — CheckoutPage", () => {
	const tree = buildPageObjectTree(exampleWorkspace(), "CheckoutPage");
	const root = tree.defs[tree.root];

	it("resolves the root and its host kind from the decorator", () => {
		expect(tree.root).toBe("e2e/page-objects/CheckoutPage.ts#CheckoutPage");
		expect(root).toMatchObject({
			hostKind: "rootPageObject",
			scope: "root-selector",
			inheritedApi: "RootPageObject",
			extendsChain: ["RootPageObject", "PageObject"],
			expanded: true,
		});
		expect(root.rootSelector).toMatchObject({
			kind: "testId",
			decorator: "RootSelector",
			testId: "CheckoutPage",
		});
	});

	it("reports the fixture binding declared in e2e/fixtures.ts", () => {
		expect(root.fixtures).toEqual([
			{
				name: "checkoutPage",
				file: "e2e/fixtures.ts",
				loc: expect.objectContaining({ file: "e2e/fixtures.ts" }),
				form: "constructor",
			},
		]);
	});

	it("covers every member result kind in one class", () => {
		expect(memberByName(root.members, "PromoCode").result).toEqual({
			kind: "pageObject",
			ref: "playwright-page-object#PageObject",
			className: "PageObject",
			external: true,
		});
		expect(memberByName(root.members, "PromoCodeInput").result).toEqual({
			kind: "locator",
		});
		expect(memberByName(root.members, "ApplyPromoButton").result).toEqual({
			kind: "pageObject",
			ref: "e2e/page-objects/controls/ButtonControl.ts#ButtonControl",
			className: "ButtonControl",
		});
		expect(memberByName(root.members, "CartItems").result).toEqual({
			kind: "list",
			listClassName: "ListPageObject",
			listRef: "playwright-page-object#ListPageObject",
			itemClassName: "CartItemControl",
			itemRef: "e2e/page-objects/CartItemControl.ts#CartItemControl",
		});
		expect(
			memberByName(root.members, "CartItemsAsPlainList").result,
		).toMatchObject({ itemDefaulted: true, itemClassName: "PageObject" });
		expect(memberByName(root.members, "CartItemRows").result).toEqual({
			kind: "locator",
		});
	});

	it("models the `CartItem_` mask as an unanchored regex", () => {
		expect(memberByName(root.members, "CartItems").selector.pattern).toEqual({
			source: "CartItem_",
			flags: "",
			origin: "string",
			matchMode: "regexUnanchored",
			literalPrefix: "CartItem_",
		});
	});

	it("lists the class's own methods and not the inherited library helpers", () => {
		const names = root.methods.map((method) => method.name);
		expect(names).toEqual([
			"applyPromoCode",
			"expectCartEmpty",
			"expectCartHasItemCount",
		]);
		expect(names).not.toContain("waitVisible");
		expect(root.methods[0].signature).toBe("applyPromoCode(code: string)");
	});

	it("dedupes ButtonControl across CheckoutPage and CartItemControl", () => {
		const cartItem =
			tree.defs["e2e/page-objects/CartItemControl.ts#CartItemControl"];
		expect(cartItem).toBeDefined();
		expect(memberByName(cartItem.members, "RemoveButton").result).toMatchObject(
			{
				ref: "e2e/page-objects/controls/ButtonControl.ts#ButtonControl",
			},
		);
		expect(
			Object.keys(tree.defs).filter((key) => key.endsWith("#ButtonControl")),
		).toHaveLength(1);
	});

	it("produces no warnings and nothing dynamic", () => {
		expect(tree.warnings).toEqual([]);
		expect(tree.stats.dynamic).toBe(0);
		expect(tree.truncated).toBeUndefined();
	});
});

describe("example/ — PlainHostCheckoutPage", () => {
	const tree = buildPageObjectTree(exampleWorkspace(), "PlainHostCheckoutPage");
	const root = tree.defs[tree.root];

	it("falls back to the `page` data property for its scope", () => {
		expect(root).toMatchObject({
			hostKind: "pageFallback",
			scope: "body",
			inheritedApi: null,
		});
		expect(root.ctorSignature).toBe("constructor(page: Page)");
	});

	it("nests the fragment reached through a constructor factory argument", () => {
		expect(memberByName(root.members, "PromoSection").result).toEqual({
			kind: "control",
			ref: "e2e/page-objects/PromoSectionFragment.ts#PromoSectionFragment",
			className: "PromoSectionFragment",
		});
		const fragment =
			tree.defs[
				"e2e/page-objects/PromoSectionFragment.ts#PromoSectionFragment"
			];
		expect(fragment).toMatchObject({
			hostKind: "fragment",
			scope: "parent-locator",
		});
		expect(memberByName(fragment.members, "PromoInput").result).toEqual({
			kind: "locator",
		});
	});
});

describe("example/ — ExternalCheckoutPage", () => {
	const tree = buildPageObjectTree(exampleWorkspace(), "ExternalCheckoutPage");
	const root = tree.defs[tree.root];

	it("keeps rootPlain even though the class also holds `page`", () => {
		expect(root).toMatchObject({
			hostKind: "rootPlain",
			scope: "root-selector",
		});
	});

	it("reads both the constructor and the inline-factory control forms", () => {
		expect(memberByName(root.members, "PromoCode").result).toEqual({
			kind: "control",
			ref: "e2e/page-objects/controls/ExternalInputControl.ts#ExternalInputControl",
			className: "ExternalInputControl",
		});
		expect(memberByName(root.members, "ApplyPromoButton").result).toMatchObject(
			{
				kind: "control",
				className: "ExternalButtonControl",
				viaInlineFactory: true,
			},
		);
		expect(memberByName(root.members, "FirstRemoveButton").result).toEqual({
			kind: "control",
			ref: "e2e/page-objects/controls/ExternalButtonControl.ts#ExternalButtonControl",
			className: "ExternalButtonControl",
		});
	});

	it("classifies the external controls by their Locator-first constructor", () => {
		const control =
			tree.defs[
				"e2e/page-objects/controls/ExternalButtonControl.ts#ExternalButtonControl"
			];
		expect(control).toMatchObject({
			hostKind: "externalControl",
			scope: "parent-locator",
		});
	});
});

describe("example/ — resolution without node_modules", () => {
	it("works from a project that only contains first-party sources", () => {
		// Nothing under example/node_modules is added, and bare specifiers are
		// never followed, so `playwright-page-object` is recognised by name alone.
		const root = toPosix(EXAMPLE_ROOT);
		const project = new Project({
			skipAddingFilesFromTsConfig: true,
			skipFileDependencyResolution: true,
			skipLoadingLibFiles: true,
			compilerOptions: {
				target: ts.ScriptTarget.ES2022,
				noEmit: true,
			},
		});
		project.addSourceFilesAtPaths(`${root}/e2e/**/*.ts`);
		expect(
			project
				.getSourceFiles()
				.every((file) => !file.getFilePath().includes("node_modules")),
		).toBe(true);

		const ws = Workspace.fromProject(
			project,
			{ projectRoot: path.resolve(EXAMPLE_ROOT) },
			{ inMemory: true },
		);
		const tree = buildPageObjectTree(ws, "CheckoutPage");
		expect(tree.defs[tree.root].rootSelector?.testId).toBe("CheckoutPage");
		expect(
			memberByName(tree.defs[tree.root].members, "CartItems").result,
		).toMatchObject({ itemClassName: "CartItemControl" });
	});
});
