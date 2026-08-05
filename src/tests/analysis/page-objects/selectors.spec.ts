import { describe, expect, it } from "vitest";
import { canonicalDecoratorName } from "../../../analysis/page-objects/libraryImports";
import {
	readPattern,
	readSelector,
} from "../../../analysis/page-objects/selectors";
import { isDynamicValue } from "../../../analysis/util/literal";
import { classFixture, libImport } from "../helpers/inMemory";

const ALL_DECORATORS = [
	"Selector",
	"SelectorBy",
	"SelectorByAltText",
	"SelectorByLabel",
	"SelectorByPlaceholder",
	"SelectorByRole",
	"SelectorByText",
	"SelectorByTitle",
	"ListSelector",
	"RootSelector",
	"ListRootSelector",
	"RootSelectorByRole",
];

function readMemberSelector(decoratorSource: string, alias?: string) {
	const code = [
		'import type { Locator } from "@playwright/test";',
		libImport(...ALL_DECORATORS) + (alias ?? ""),
		"export class Host {",
		`  ${decoratorSource}`,
		"  accessor target!: Locator;",
		"}",
	].join("\n");
	const fixture = classFixture(code, "Host");
	const [decorator] = fixture.cls.getPropertyOrThrow("target").getDecorators();
	const canonical = canonicalDecoratorName(decorator, fixture.imports);
	if (!canonical) {
		throw new Error("not a library decorator");
	}
	return readSelector(decorator, canonical, fixture.imports, fixture.ctx)
		.selector;
}

describe("readSelector — kinds", () => {
	it("maps a bare @Selector() to `self`", () => {
		const selector = readMemberSelector("@Selector()");
		expect(selector.kind).toBe("self");
		expect(selector.dynamic).toBe(false);
		expect(selector.testId).toBeUndefined();
	});

	it("maps @Selector(id) to a testId selector", () => {
		const selector = readMemberSelector('@Selector("PromoCodeInput")');
		expect(selector).toMatchObject({
			kind: "testId",
			decorator: "Selector",
			dynamic: false,
			testId: "PromoCodeInput",
			raw: '@Selector("PromoCodeInput")',
		});
	});

	it("maps @SelectorByRole to role plus options", () => {
		const selector = readMemberSelector(
			'@SelectorByRole("button", { name: "Apply" })',
		);
		expect(selector).toMatchObject({
			kind: "role",
			role: "button",
			options: { name: "Apply" },
			dynamic: false,
		});
	});

	it("maps the text-like decorators onto `text`", () => {
		expect(readMemberSelector('@SelectorByText("Apply")')).toMatchObject({
			kind: "text",
			text: "Apply",
		});
		expect(readMemberSelector('@SelectorByLabel("Promo")')).toMatchObject({
			kind: "label",
			text: "Promo",
		});
		expect(
			readMemberSelector('@SelectorByPlaceholder("Enter code")'),
		).toMatchObject({ kind: "placeholder", text: "Enter code" });
		expect(readMemberSelector('@SelectorByAltText("Logo")')).toMatchObject({
			kind: "altText",
			text: "Logo",
		});
		expect(readMemberSelector('@SelectorByTitle("Tip")')).toMatchObject({
			kind: "title",
			text: "Tip",
		});
	});

	it("maps @SelectorBy to an always-dynamic custom selector", () => {
		const selector = readMemberSelector(
			"@SelectorBy((root, value) => root.getByTestId(value))",
		);
		expect(selector.kind).toBe("custom");
		expect(selector.dynamic).toBe(true);
		expect(selector.raw).toContain("getByTestId");
	});

	it("reads root decorators through the same path", () => {
		const selector = readMemberSelector('@RootSelector("CheckoutPage")');
		expect(selector).toMatchObject({
			kind: "testId",
			decorator: "RootSelector",
			testId: "CheckoutPage",
		});
	});
});

describe("readSelector — patterns", () => {
	it("treats a string mask as an unanchored regex, not a prefix", () => {
		const selector = readMemberSelector('@ListSelector("CartItem_")');
		expect(selector.kind).toBe("testIdPattern");
		expect(selector.pattern).toEqual({
			source: "CartItem_",
			flags: "",
			origin: "string",
			matchMode: "regexUnanchored",
			literalPrefix: "CartItem_",
		});
	});

	it("preserves the source and flags of a RegExp literal", () => {
		const selector = readMemberSelector("@ListSelector(/^Item_\\d+$/i)");
		expect(selector.pattern).toEqual({
			source: "^Item_\\d+$",
			flags: "i",
			origin: "regex",
			matchMode: "regex",
			literalPrefix: "Item_",
		});
	});

	it("falls back to dynamic when the mask is not a literal", () => {
		const selector = readMemberSelector("@ListSelector(mask)");
		expect(selector.pattern).toBeUndefined();
		expect(selector.dynamic).toBe(true);
	});

	it("handles ListRootSelector the same way", () => {
		const selector = readMemberSelector('@ListRootSelector("Row_")');
		expect(selector.pattern?.matchMode).toBe("regexUnanchored");
	});
});

describe("readSelector — dynamic values", () => {
	it("marks a computed option value dynamic while keeping the shape", () => {
		const selector = readMemberSelector(
			'@SelectorByRole("button", { name: label })',
		);
		expect(selector.dynamic).toBe(true);
		expect(selector.options).toBeDefined();
		if (selector.options && isDynamicValue(selector.options)) {
			expect(selector.options.reason).toBe("identifier-unresolved");
		}
	});

	it("drops arguments entirely on a spread", () => {
		const selector = readMemberSelector("@SelectorByRole(...args)");
		expect(selector.dynamic).toBe(true);
		expect(selector.role).toBeUndefined();
		expect(selector.notes?.join(" ")).toContain("Spread");
	});
});

describe("readSelector — raw text", () => {
	it("collapses whitespace", () => {
		const selector = readMemberSelector(
			'@SelectorByRole(\n    "button",\n    { name: "Apply" },\n  )',
		);
		expect(selector.raw).toBe(
			'@SelectorByRole( "button", { name: "Apply" }, )',
		);
	});

	it("truncates at 200 characters", () => {
		const long = "x".repeat(400);
		const selector = readMemberSelector(`@Selector("${long}")`);
		expect(selector.raw.length).toBe(200);
		expect(selector.raw.endsWith("…")).toBe(true);
	});
});

describe("readPattern", () => {
	it("returns null for a non-literal node", () => {
		const code = ["export const value = someMask;"].join("\n");
		const fixture = classFixture(`class Host {}\n${code}`, "Host");
		const initializer = fixture.sourceFile
			.getVariableDeclarationOrThrow("value")
			.getInitializerOrThrow();
		expect(readPattern(initializer)).toBeNull();
	});
});
