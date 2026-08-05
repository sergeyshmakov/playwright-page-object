import { describe, expect, it } from "vitest";
import { readMethods } from "../../../analysis/page-objects/methods";
import { classFixture, libImport } from "../helpers/inMemory";

const PRELUDE = [
	'import type { Locator } from "@playwright/test";',
	libImport("PageObject", "Selector"),
].join("\n");

function methodsOf(
	body: string,
	options: Parameters<typeof readMethods>[3] = {},
	extraFiles: Record<string, string> = {},
	header = "export class Host extends PageObject {",
) {
	const fixture = classFixture(
		[PRELUDE, header, body, "}"].join("\n"),
		"Host",
		extraFiles,
	);
	return readMethods(fixture.cls, fixture.imports, fixture.ctx, options);
}

describe("readMethods", () => {
	it("lists public methods with syntactic signatures", () => {
		const methods = methodsOf(
			[
				"  async applyPromoCode(code: string) { void code; }",
				"  expectCartHasItemCount(n: number): Promise<void> { void n; return Promise.resolve(); }",
			].join("\n"),
		);
		expect(methods.map((method) => method.signature)).toEqual([
			"applyPromoCode(code: string)",
			"expectCartHasItemCount(n: number): Promise<void>",
		]);
		expect(methods[0].isAsync).toBe(true);
		expect(methods[0].returnType).toBeNull();
		expect(methods[1].returnType).toBe("Promise<void>");
	});

	it("skips the constructor", () => {
		const methods = methodsOf("  constructor() { super(); }");
		expect(methods).toHaveLength(0);
	});

	it("skips private and #private members but keeps protected ones", () => {
		const methods = methodsOf(
			[
				"  private hidden() {}",
				"  #alsoHidden() {}",
				"  protected shared() {}",
			].join("\n"),
		);
		expect(methods.map((method) => method.name)).toEqual(["shared"]);
	});

	it("reports getters and setters with their own kind", () => {
		const methods = methodsOf(
			[
				"  get total(): number { return 1; }",
				"  set total(v: number) { void v; }",
			].join("\n"),
		);
		expect(methods).toHaveLength(1);
		expect(methods[0]).toMatchObject({ name: "total", kind: "getter" });
	});

	it("does not list a decorated accessor as a method", () => {
		const methods = methodsOf(
			['  @Selector("x")\n  accessor field!: Locator;', "  run() {}"].join(
				"\n",
			),
		);
		expect(methods.map((method) => method.name)).toEqual(["run"]);
	});

	it("flags static methods", () => {
		const methods = methodsOf("  static create() { return new Host(); }");
		expect(methods[0]).toMatchObject({ name: "create", isStatic: true });
	});

	it("captures a one-line JSDoc summary and truncates a long one", () => {
		const long = "w ".repeat(200);
		const methods = methodsOf(
			[
				"  /** Applies the code. Then waits. */",
				"  applyPromoCode() {}",
				`  /** ${long} */`,
				"  other() {}",
			].join("\n"),
		);
		expect(methods[0].doc).toBe("Applies the code.");
		expect(methods[1].doc?.length).toBe(160);
	});

	it("infers a return type only in `checked` mode", () => {
		const syntactic = methodsOf("  count() { return 3; }");
		expect(syntactic[0].returnType).toBeNull();
		const checked = methodsOf("  count() { return 3; }", {
			signatureMode: "checked",
		});
		expect(checked[0].returnType).toBe("number");
	});

	it("adds project-local base-class methods only when asked", () => {
		const extra = {
			"src/base.ts": [
				'import { PageObject } from "playwright-page-object";',
				"export class Base extends PageObject {",
				"  fromBase() {}",
				"}",
			].join("\n"),
		};
		const header = "export class Host extends Base {";
		const withImport = `${PRELUDE}\nimport { Base } from "./base";`;
		const fixture = classFixture(
			[withImport, header, "  own() {}", "}"].join("\n"),
			"Host",
			extra,
		);
		const own = readMethods(fixture.cls, fixture.imports, fixture.ctx);
		expect(own.map((method) => method.name)).toEqual(["own"]);
		const inherited = readMethods(fixture.cls, fixture.imports, fixture.ctx, {
			includeInherited: true,
		});
		expect(inherited.map((method) => method.name).sort()).toEqual([
			"fromBase",
			"own",
		]);
	});

	it("renders optional and rest parameters", () => {
		const methods = methodsOf(
			"  go(first: string, second?: number, ...rest: string[]) { void first; void second; void rest; }",
		);
		expect(methods[0].signature).toBe(
			"go(first: string, second?: number, ...rest: string[])",
		);
	});
});
