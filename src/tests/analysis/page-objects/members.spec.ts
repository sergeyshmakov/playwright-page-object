import { describe, expect, it } from "vitest";
import { readMember } from "../../../analysis/page-objects/members";
import type { MemberNode } from "../../../analysis/types";
import { classFixture, libImport } from "../helpers/inMemory";

const IMPORTS = [
	"ListPageObject",
	"ListSelector",
	"PageObject",
	"RootPageObject",
	"Selector",
	"SelectorByRole",
];

function readOne(
	body: string,
	memberName: string,
	extraFiles: Record<string, string> = {},
	extraImports = "",
): MemberNode {
	const code = [
		'import type { Locator } from "@playwright/test";',
		libImport(...IMPORTS),
		extraImports,
		"export class Host extends PageObject {",
		body,
		"}",
	].join("\n");
	const fixture = classFixture(code, "Host", extraFiles);
	const member = fixture.cls
		.getMembers()
		.find((candidate) => candidate.getText().includes(memberName));
	if (!member) {
		throw new Error(`member ${memberName} not found`);
	}
	const read = readMember(member, fixture.imports, fixture.ctx);
	if (!read) {
		throw new Error(`member ${memberName} carries no library decorator`);
	}
	return read.member;
}

const ITEM_FILE = {
	"src/Item.ts": [
		'import { PageObject } from "playwright-page-object";',
		"export class Item extends PageObject {}",
	].join("\n"),
};
const ITEM_IMPORT = 'import { Item } from "./Item";';

describe("inferResult — lists", () => {
	it("reads `new ListPageObject(Item)` as a list with an item ref", () => {
		const member = readOne(
			'  @ListSelector("Row_")\n  accessor rows = new ListPageObject(Item);',
			"rows",
			ITEM_FILE,
			ITEM_IMPORT,
		);
		expect(member.result).toEqual({
			kind: "list",
			listClassName: "ListPageObject",
			listRef: "playwright-page-object#ListPageObject",
			itemClassName: "Item",
			itemRef: "src/Item.ts#Item",
		});
	});

	it("defaults the item type when the list is constructed empty", () => {
		const member = readOne(
			'  @ListSelector("Row_")\n  accessor rows = new ListPageObject();',
			"rows",
		);
		expect(member.result).toMatchObject({
			kind: "list",
			itemClassName: "PageObject",
			itemRef: "playwright-page-object#PageObject",
			itemDefaulted: true,
		});
	});

	it("accepts the instance form and yields the same item ref", () => {
		const member = readOne(
			'  @ListSelector("Row_")\n  accessor rows = new ListPageObject(new Item());',
			"rows",
			ITEM_FILE,
			ITEM_IMPORT,
		);
		expect(member.result).toMatchObject({
			kind: "list",
			itemRef: "src/Item.ts#Item",
			itemClassName: "Item",
		});
	});

	it("recognises a user subclass of ListPageObject as a list", () => {
		const member = readOne(
			'  @ListSelector("Row_")\n  accessor rows = new MyList(Item);',
			"rows",
			{
				...ITEM_FILE,
				"src/MyList.ts": [
					'import { ListPageObject } from "playwright-page-object";',
					"export class MyList extends ListPageObject {}",
				].join("\n"),
			},
			`${ITEM_IMPORT}\nimport { MyList } from "./MyList";`,
		);
		expect(member.result).toMatchObject({
			kind: "list",
			listClassName: "MyList",
			listRef: "src/MyList.ts#MyList",
			itemRef: "src/Item.ts#Item",
		});
	});
});

describe("inferResult — page objects and controls", () => {
	it("reads `new PageObject()` as an external library page object", () => {
		const member = readOne(
			'  @Selector("x")\n  accessor field = new PageObject();',
			"field",
		);
		expect(member.result).toEqual({
			kind: "pageObject",
			ref: "playwright-page-object#PageObject",
			className: "PageObject",
			external: true,
		});
	});

	it("reads `new Item()` as a project page object", () => {
		const member = readOne(
			'  @Selector("x")\n  accessor field = new Item();',
			"field",
			ITEM_FILE,
			ITEM_IMPORT,
		);
		expect(member.result).toEqual({
			kind: "pageObject",
			ref: "src/Item.ts#Item",
			className: "Item",
		});
	});

	it("reads a constructor factory argument as a control", () => {
		const member = readOne(
			'  @Selector("x", Ctrl)\n  accessor field!: Ctrl;',
			"field",
			{ "src/Ctrl.ts": "export class Ctrl {}" },
			'import { Ctrl } from "./Ctrl";',
		);
		expect(member.result).toEqual({
			kind: "control",
			ref: "src/Ctrl.ts#Ctrl",
			className: "Ctrl",
		});
	});

	// `class Ctrl {}; export { Ctrl as CheckoutCtrl }` is an ordinary alias export,
	// but resolving the import searched only for an import binding called `Ctrl`.
	// The local declaration went unseen and a fully static control came back with
	// a null ref, dropping it out of the expanded page-object graph.
	it("reads a control exported under an alias of a local class", () => {
		const member = readOne(
			'  @Selector("x", CheckoutCtrl)\n  accessor field!: CheckoutCtrl;',
			"field",
			{ "src/Ctrl.ts": "class Ctrl {}\nexport { Ctrl as CheckoutCtrl };" },
			'import { CheckoutCtrl } from "./Ctrl";',
		);
		// `className` stays the name written at the call site; `ref` is the one that
		// has to point at the declaration, and it was `null`.
		expect(member.result).toEqual({
			kind: "control",
			ref: "src/Ctrl.ts#Ctrl",
			className: "CheckoutCtrl",
		});
	});

	it("marks an inline arrow factory with viaInlineFactory", () => {
		const member = readOne(
			'  @SelectorByRole("button", {}, (l) => new Ctrl(l))\n  accessor field!: Ctrl;',
			"field",
			{ "src/Ctrl.ts": "export class Ctrl {}" },
			'import { Ctrl } from "./Ctrl";',
		);
		expect(member.result).toMatchObject({
			kind: "control",
			className: "Ctrl",
			viaInlineFactory: true,
		});
	});
});

describe("inferResult — namespaced constructors", () => {
	// `new pages.Button()` was accepted and resolved; `new pages.controls.Button()`
	// was accepted and silently lost its ref, so the member vanished from the
	// expanded graph.
	it("resolves a nested namespace chain to the real class", () => {
		const member = readOne(
			"  @Selector('x')\n  accessor field = new pages.controls.Button();",
			"field",
			{
				"src/pages.ts": 'export * as controls from "./controls";',
				"src/controls.ts": [
					'import { PageObject } from "playwright-page-object";',
					"export class Button extends PageObject {}",
				].join("\n"),
			},
			'import * as pages from "./pages";',
		);
		expect(member.result).toMatchObject({
			kind: "pageObject",
			className: "Button",
			ref: "src/controls.ts#Button",
		});
	});

	it("keeps a one-segment namespace working", () => {
		const member = readOne(
			"  @Selector('x')\n  accessor field = new pages.Button();",
			"field",
			{
				"src/pages.ts": [
					'import { PageObject } from "playwright-page-object";',
					"export class Button extends PageObject {}",
				].join("\n"),
			},
			'import * as pages from "./pages";',
		);
		expect(member.result).toMatchObject({
			kind: "pageObject",
			ref: "src/pages.ts#Button",
		});
	});
});

describe("inferResult — locators", () => {
	it("reads a Locator annotation as a raw locator", () => {
		const member = readOne(
			'  @Selector("x")\n  accessor field!: Locator;',
			"field",
		);
		expect(member.result).toEqual({ kind: "locator" });
		expect(member.warnings).toBeUndefined();
	});

	it("warns when the annotation names a class but nothing constructs it", () => {
		const member = readOne(
			'  @Selector("x")\n  accessor field!: Item;',
			"field",
			ITEM_FILE,
			ITEM_IMPORT,
		);
		expect(member.result).toEqual({ kind: "locator" });
		expect(
			member.warnings?.some((diag) => diag.code === "type-annotation-mismatch"),
		).toBe(true);
	});

	it("reports an undecidable member as unknown", () => {
		const member = readOne('  @Selector("x")\n  accessor field;', "field");
		expect(member.result).toMatchObject({ kind: "unknown", dynamic: true });
	});
});

describe("readMember — metadata", () => {
	it("captures visibility, doc summary and location", () => {
		const member = readOne(
			[
				"  /** The promo input. Extra detail is dropped. */",
				'  @Selector("PromoCodeInput")',
				"  protected accessor field!: Locator;",
			].join("\n"),
			"field",
		);
		expect(member.visibility).toBe("protected");
		expect(member.doc).toBe("The promo input.");
		expect(member.loc.file).toBe("src/fixture.ts");
		expect(member.loc.line).toBeGreaterThan(0);
	});

	it("returns null for members with no library decorator", () => {
		const code = [
			'import type { Locator } from "@playwright/test";',
			libImport("Selector"),
			"export class Host {",
			"  plain!: Locator;",
			"}",
		].join("\n");
		const fixture = classFixture(code, "Host");
		const member = fixture.cls.getPropertyOrThrow("plain");
		expect(readMember(member, fixture.imports, fixture.ctx)).toBeNull();
	});
});
