import { Node } from "ts-morph";
import { describe, expect, it } from "vitest";
import { splitFactoryArg } from "../../../analysis/page-objects/decoratorArgs";
import { canonicalDecoratorName } from "../../../analysis/page-objects/libraryImports";
import { classFixture, libImport } from "../helpers/inMemory";

/** Splits the arguments of the first decorator on `Host.target`. */
function split(
	decoratorSource: string,
	extraFiles: Record<string, string> = {},
	imports = ["Selector", "SelectorByRole", "SelectorByText", "ListSelector"],
) {
	const code = [
		'import type { Locator } from "@playwright/test";',
		libImport(...imports),
		Object.keys(extraFiles).length > 0
			? Object.keys(extraFiles)
					.map((file) => {
						const name = file.replace(/^src\//, "").replace(/\.tsx?$/, "");
						return `import { ${name} } from "./${name}";`;
					})
					.join("\n")
			: "",
		"export class Host {",
		`  ${decoratorSource}`,
		"  accessor target!: Locator;",
		"}",
	].join("\n");

	const fixture = classFixture(code, "Host", extraFiles);
	const member = fixture.cls.getPropertyOrThrow("target");
	const [decorator] = member.getDecorators();
	const canonical = canonicalDecoratorName(decorator, fixture.imports);
	if (!canonical) {
		throw new Error("fixture decorator is not a library decorator");
	}
	return {
		canonical,
		result: splitFactoryArg(
			canonical,
			decorator.getArguments(),
			fixture.sourceFile,
			fixture.imports,
			fixture.ctx,
		),
	};
}

const CTRL_FILE = { "src/Ctrl.ts": "export class Ctrl {}" };
const PAGE_OBJECT_CTRL = {
	"src/Ctrl.ts": [
		'import { PageObject } from "playwright-page-object";',
		"export class Ctrl extends PageObject {}",
	].join("\n"),
};

describe("splitFactoryArg — fixed-arity decorators", () => {
	it("treats arg[1] of @Selector as the factory", () => {
		const { result } = split('@Selector("x", Ctrl)', CTRL_FILE);
		expect(result.valueArgs).toHaveLength(1);
		expect(result.factory?.className).toBe("Ctrl");
		expect(result.factory?.form).toBe("identifier");
	});

	it("leaves a single-argument @Selector without a factory", () => {
		const { result } = split('@Selector("x")');
		expect(result.factory).toBeNull();
		expect(result.valueArgs).toHaveLength(1);
	});

	it("applies the same positional rule to @SelectorByText", () => {
		const { result } = split('@SelectorByText("Apply", Ctrl)', CTRL_FILE);
		expect(result.factory?.className).toBe("Ctrl");
		expect(result.valueArgs).toHaveLength(1);
	});

	it("applies the same positional rule to @ListSelector", () => {
		const { result } = split('@ListSelector("Item_", Ctrl)', CTRL_FILE);
		expect(result.factory?.className).toBe("Ctrl");
	});
});

describe("splitFactoryArg — variadic decorators", () => {
	it("does not mistake a trailing options object for a factory", () => {
		const { result } = split('@SelectorByRole("button", { name: "Apply" })');
		expect(result.factory).toBeNull();
		expect(result.valueArgs).toHaveLength(2);
	});

	it("accepts a trailing identifier that resolves to a class", () => {
		const { result } = split(
			'@SelectorByRole("button", { name: "A" }, Ctrl)',
			CTRL_FILE,
		);
		expect(result.factory?.className).toBe("Ctrl");
		expect(result.valueArgs).toHaveLength(2);
	});

	it("accepts an inline arrow that constructs one class", () => {
		const { result } = split(
			'@SelectorByRole("button", { name: "A" }, (l) => new Ctrl(l))',
			CTRL_FILE,
		);
		expect(result.factory?.form).toBe("arrow");
		expect(result.factory?.viaInlineFactory).toBe(true);
		expect(result.factory?.className).toBe("Ctrl");
		expect(result.factory?.dynamic).toBe(false);
	});

	it("marks an arrow that does not construct a class as dynamic", () => {
		const { result } = split(
			'@SelectorByRole("button", { name: "A" }, (l) => wrap(l))',
		);
		expect(result.factory?.className).toBeNull();
		expect(result.factory?.dynamic).toBe(true);
		expect(
			result.warnings.some((diag) => diag.code === "dynamic-selector-arg"),
		).toBe(true);
	});

	it("marks an inline arrow constructing an unresolvable class as dynamic", () => {
		const { result } = split(
			'@SelectorByRole("button", { name: "A" }, (l) => new MissingCtrl(l))',
		);
		expect(result.factory?.viaInlineFactory).toBe(true);
		expect(result.factory?.dynamic).toBe(true);
	});

	it("treats an unresolvable capitalised trailing identifier as a factory", () => {
		const { result } = split('@SelectorByRole("button", {}, Unknown)');
		expect(result.factory?.className).toBe("Unknown");
		expect(result.factory?.dynamic).toBe(true);
		expect(result.notes.join(" ")).toContain("uppercase");
	});

	it("treats an unresolvable lowercase trailing identifier as a value", () => {
		const { result } = split('@SelectorByRole("button", options)');
		expect(result.factory).toBeNull();
		expect(result.valueArgs).toHaveLength(2);
		expect(result.notes.join(" ")).toContain("lowercase");
	});
});

describe("splitFactoryArg — failure modes", () => {
	it("gives up on a spread and says so", () => {
		const { result } = split("@SelectorByRole(...args)");
		expect(result.hasSpread).toBe(true);
		expect(result.valueArgs).toHaveLength(0);
		expect(result.factory).toBeNull();
		expect(result.warnings[0]?.code).toBe("dynamic-selector-arg");
	});

	it("warns when a PageObject subclass is passed as a factory", () => {
		const { result } = split('@Selector("x", Ctrl)', PAGE_OBJECT_CTRL);
		expect(
			result.warnings.some(
				(diag) => diag.code === "page-object-passed-as-factory",
			),
		).toBe(true);
	});

	it("warns for a PageObject subclass held in a class expression", () => {
		const { result } = split('@Selector("x", Ctrl)', {
			"src/Ctrl.ts": [
				'import { PageObject } from "playwright-page-object";',
				"export const Ctrl = class extends PageObject {};",
			].join("\n"),
		});
		expect(
			result.warnings.some(
				(diag) => diag.code === "page-object-passed-as-factory",
			),
		).toBe(true);
	});

	it("does not name a function factory as the control class", () => {
		const { result } = split('@Selector("x", Ctrl)', {
			"src/Ctrl.ts":
				"export function Ctrl(locator: unknown) { return locator; }",
		});
		expect(result.factory?.className).toBeNull();
		expect(result.factory?.dynamic).toBe(true);
		expect(result.notes.join(" ")).toContain("not a class");
	});
});

describe("canonicalDecoratorName", () => {
	it("resolves an aliased import back to the library export", () => {
		const code = [
			'import type { Locator } from "@playwright/test";',
			'import { Selector as S } from "playwright-page-object";',
			"export class Host {",
			'  @S("x")',
			"  accessor target!: Locator;",
			"}",
		].join("\n");
		const fixture = classFixture(code, "Host");
		const [decorator] = fixture.cls
			.getPropertyOrThrow("target")
			.getDecorators();
		expect(canonicalDecoratorName(decorator, fixture.imports)).toBe("Selector");
	});

	it("resolves a namespace import", () => {
		const code = [
			'import type { Locator } from "@playwright/test";',
			'import * as ppo from "playwright-page-object";',
			"export class Host {",
			'  @ppo.Selector("x")',
			"  accessor target!: Locator;",
			"}",
		].join("\n");
		const fixture = classFixture(code, "Host");
		const [decorator] = fixture.cls
			.getPropertyOrThrow("target")
			.getDecorators();
		expect(canonicalDecoratorName(decorator, fixture.imports)).toBe("Selector");
	});

	it("ignores a same-named decorator imported from somewhere else", () => {
		const code = [
			'import type { Locator } from "@playwright/test";',
			'import { Selector } from "./mine";',
			"export class Host {",
			'  @Selector("x")',
			"  accessor target!: Locator;",
			"}",
		].join("\n");
		const fixture = classFixture(code, "Host", {
			"src/mine.ts":
				"export function Selector(_id: string) { return () => {}; }",
		});
		const [decorator] = fixture.cls
			.getPropertyOrThrow("target")
			.getDecorators();
		expect(canonicalDecoratorName(decorator, fixture.imports)).toBeUndefined();
		expect(Node.isDecorator(decorator)).toBe(true);
	});
});
