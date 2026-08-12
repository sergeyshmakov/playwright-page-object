import { describe, expect, it } from "vitest";
import {
	classifyHost,
	findDataProperty,
	readHeritage,
} from "../../../analysis/page-objects/hostKind";
import { classFixture, libImport } from "../helpers/inMemory";

function classify(
	code: string,
	className: string,
	extraFiles: Record<string, string> = {},
	options: { referencedAsFactoryArg?: boolean } = {},
) {
	const fixture = classFixture(code, className, extraFiles);
	return classifyHost(fixture.cls, fixture.imports, fixture.ctx, options);
}

const PRELUDE = 'import type { Locator, Page } from "@playwright/test";\n';

describe("classifyHost", () => {
	it("classifies a decorated RootPageObject subclass as rootPageObject", () => {
		const result = classify(
			[
				PRELUDE,
				libImport("RootSelector", "RootPageObject"),
				'@RootSelector("CheckoutPage")',
				"export class Checkout extends RootPageObject {}",
			].join("\n"),
			"Checkout",
		);
		expect(result.hostKind).toBe("rootPageObject");
		expect(result.scope).toBe("root-selector");
		expect(result.heritage.chain).toEqual(["RootPageObject", "PageObject"]);
		expect(result.heritage.inheritedApi).toBe("RootPageObject");
	});

	it("uses `body` scope for a bare @RootSelector()", () => {
		const result = classify(
			[
				libImport("RootSelector", "RootPageObject"),
				"@RootSelector()",
				"export class Checkout extends RootPageObject {}",
			].join("\n"),
			"Checkout",
		);
		expect(result.scope).toBe("body");
	});

	it("classifies a decorated plain class as rootPlain even when it holds `page`", () => {
		// The decorator installs LOCATOR_SYMBOL, which resolveLocator checks
		// before the `page` fallback — so rootPlain must beat pageFallback.
		const result = classify(
			[
				PRELUDE,
				libImport("RootSelector"),
				'@RootSelector("CheckoutPage")',
				"export class ExternalCheckout {",
				"  constructor(readonly page: Page) {}",
				"}",
			].join("\n"),
			"ExternalCheckout",
		);
		expect(result.hostKind).toBe("rootPlain");
		expect(result.scope).toBe("root-selector");
	});

	it("classifies a plain class holding `page` as pageFallback", () => {
		const result = classify(
			[
				PRELUDE,
				libImport("Selector"),
				"export class Plain {",
				"  constructor(readonly page: Page) {}",
				'  @Selector("x")',
				"  accessor target!: Locator;",
				"}",
			].join("\n"),
			"Plain",
		);
		expect(result.hostKind).toBe("pageFallback");
		expect(result.scope).toBe("body");
	});

	it("classifies a class holding a `locator` parameter property as a fragment", () => {
		const result = classify(
			[
				PRELUDE,
				libImport("Selector"),
				"export class Fragment {",
				"  constructor(readonly locator: Locator) {}",
				'  @Selector("x")',
				"  accessor target!: Locator;",
				"}",
			].join("\n"),
			"Fragment",
		);
		expect(result.hostKind).toBe("fragment");
		expect(result.scope).toBe("parent-locator");
	});

	it("accepts a plain `locator` field as a fragment host", () => {
		const result = classify(
			[
				PRELUDE,
				libImport("Selector"),
				"export class Fragment {",
				"  locator: Locator = undefined as unknown as Locator;",
				'  @Selector("x")',
				"  accessor target!: Locator;",
				"}",
			].join("\n"),
			"Fragment",
		);
		expect(result.hostKind).toBe("fragment");
	});

	it("does NOT treat a `get locator()` accessor as a fragment host", () => {
		// getDataPropertyValue reads data properties only (selectorBy.ts:8-26).
		const result = classify(
			[
				PRELUDE,
				libImport("Selector"),
				"export class GetterOnly {",
				"  constructor(private readonly _locator: Locator) {}",
				"  get locator(): Locator { return this._locator; }",
				'  @Selector("x")',
				"  accessor target!: Locator;",
				"}",
			].join("\n"),
			"GetterOnly",
		);
		expect(result.hostKind).not.toBe("fragment");
		expect(result.hostKind).toBe("unknown");
		expect(
			result.warnings.some((diag) => diag.code === "missing-host-context"),
		).toBe(true);
	});

	it("classifies a PageObject subclass without a root decorator as nested", () => {
		const result = classify(
			[
				libImport("PageObject"),
				"export class ButtonControl extends PageObject {}",
			].join("\n"),
			"ButtonControl",
		);
		expect(result.hostKind).toBe("nestedPageObject");
		expect(result.scope).toBe("parent-locator");
		expect(result.heritage.inheritedApi).toBe("PageObject");
	});

	it("classifies a Locator-first constructor referenced as a factory arg", () => {
		const result = classify(
			[
				PRELUDE,
				"export class ExternalButton {",
				"  constructor(private readonly _locator: Locator) {}",
				"  get locator(): Locator { return this._locator; }",
				"}",
			].join("\n"),
			"ExternalButton",
			{},
			{ referencedAsFactoryArg: true },
		);
		expect(result.hostKind).toBe("externalControl");
		expect(result.scope).toBe("parent-locator");
	});

	it("falls back to unknown for a class with no host context at all", () => {
		const result = classify("export class Plain {}", "Plain");
		expect(result.hostKind).toBe("unknown");
		expect(result.scope).toBe("unknown");
		expect(result.warnings).toHaveLength(0);
	});
});

describe("readHeritage", () => {
	it("walks through a project-local intermediate base", () => {
		const result = classify(
			[
				'import { Base } from "./base";',
				"export class Child extends Base {}",
			].join("\n"),
			"Child",
			{
				"src/base.ts": [
					'import { PageObject } from "playwright-page-object";',
					"export class Base extends PageObject {}",
				].join("\n"),
			},
		);
		expect(result.heritage.chain).toEqual(["Base", "PageObject"]);
		expect(result.heritage.inheritedApi).toBe("PageObject");
		expect(result.hostKind).toBe("nestedPageObject");
	});

	it("recognises a base class reached through a namespace import", () => {
		const result = classify(
			[
				'import * as po from "playwright-page-object";',
				"export class Child extends po.RootPageObject {}",
			].join("\n"),
			"Child",
		);
		expect(result.heritage.chain).toEqual(["RootPageObject", "PageObject"]);
		expect(result.heritage.inheritedApi).toBe("RootPageObject");
		expect(result.hostKind).toBe("rootPageObject");
	});

	it("ignores a type-only import of a library base class", () => {
		const result = classify(
			[
				'import type { PageObject } from "playwright-page-object";',
				"export class Child implements PageObject {}",
			].join("\n"),
			"Child",
		);
		expect(result.heritage.inheritedApi).toBeNull();
	});

	it("expands ListPageObject into its own chain", () => {
		const result = classify(
			[
				libImport("ListPageObject"),
				"export class Rows extends ListPageObject {}",
			].join("\n"),
			"Rows",
		);
		expect(result.heritage.chain).toEqual(["ListPageObject", "PageObject"]);
		expect(result.heritage.inheritedApi).toBe("ListPageObject");
	});

	it("stops at an unresolvable base without throwing", () => {
		const fixture = classFixture(
			'import { Base } from "unknown-package";\nexport class Child extends Base {}',
			"Child",
		);
		const heritage = readHeritage(fixture.cls, fixture.imports, fixture.ctx);
		expect(heritage.chain).toEqual(["Base"]);
		expect(heritage.inheritedApi).toBeNull();
	});

	it("reaches a library base five project-local bases up", () => {
		// The cap was 5, which a design system reaches without trying. The leaf
		// came back `inheritedApi: null`, and a leaf with no decorators or fixture
		// binding of its own then failed discovery outright - silently absent from
		// every answer, while inheriting the whole page-object API.
		const files: Record<string, string> = {};
		for (let index = 0; index < 5; index += 1) {
			files[`src/b${index}.ts`] =
				`import { B${index + 1} } from "./b${index + 1}";\nexport class B${index} extends B${index + 1} {}`;
		}
		files["src/b5.ts"] = [
			libImport("PageObject"),
			"export class B5 extends PageObject {}",
		].join("\n");
		const fixture = classFixture(
			'import { B0 } from "./b0";\nexport class Child extends B0 {}',
			"Child",
			files,
		);
		const heritage = readHeritage(fixture.cls, fixture.imports, fixture.ctx);
		expect(heritage.truncated).toBe(false);
		expect(heritage.inheritedApi).toBe("PageObject");
	});

	it("terminates on a cyclic `extends` instead of running to the cap", () => {
		// Illegal TypeScript, and a real thing to find on disk mid-edit. The cap
		// used to be the only thing stopping this, which made a cycle
		// indistinguishable from a chain that is merely deep - and it is the
		// reason a cap cannot be the termination argument on its own.
		const fixture = classFixture(
			'import { B0 } from "./b0";\nexport class Child extends B0 {}',
			"Child",
			{
				"src/b0.ts":
					'import { B1 } from "./b1";\nexport class B0 extends B1 {}',
				"src/b1.ts":
					'import { B0 } from "./b0";\nexport class B1 extends B0 {}',
			},
		);
		const heritage = readHeritage(fixture.cls, fixture.imports, fixture.ctx);
		expect(heritage.truncated).toBe(true);
		expect(heritage.inheritedApi).toBeNull();
		expect(heritage.chain.length).toBeLessThan(8);
	});
});

describe("findDataProperty", () => {
	it("ignores an `accessor` property, which installs a get/set pair", () => {
		const fixture = classFixture(
			[
				PRELUDE,
				"export class Host {",
				"  accessor locator!: Locator;",
				"}",
			].join("\n"),
			"Host",
		);
		expect(findDataProperty(fixture.cls, "locator")).toBeUndefined();
	});

	it("ignores a `declare` field, which emits nothing", () => {
		const fixture = classFixture(
			[PRELUDE, "export class Host {", "  declare locator: Locator;", "}"].join(
				"\n",
			),
			"Host",
		);
		expect(findDataProperty(fixture.cls, "locator")).toBeUndefined();
	});
});
