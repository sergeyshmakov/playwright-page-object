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

/** `Host extends Base`, where `Base` declares `fromBase()` in another file. */
function inheritanceFixture(body = "  own() {}") {
	return classFixture(
		[
			PRELUDE,
			'import { Base } from "./base";',
			"export class Host extends Base {",
			body,
			"}",
		].join("\n"),
		"Host",
		{
			"src/base.ts": [
				'import { PageObject } from "playwright-page-object";',
				"export class Base extends PageObject {",
				"  fromBase() {}",
				"}",
			].join("\n"),
		},
	);
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

	// `total(): number` for a getter is a `TypeError` an agent only finds at run
	// time: it writes `await page.total()` and the property is not callable.
	it("renders an accessor as a property read, not as a call", () => {
		const getter = methodsOf("  get total(): number { return 1; }");
		expect(getter[0].signature).toBe("get total: number");

		const bare = methodsOf("  get total() { return 1; }");
		expect(bare[0].signature).toBe("get total");

		const setter = methodsOf("  set total(value: number) { void value; }");
		expect(setter[0]).toMatchObject({
			kind: "setter",
			signature: "set total(value: number)",
			returnType: null,
		});
	});

	it("records visibility, so a protected helper is not read as public API", () => {
		const methods = methodsOf(
			["  protected shared() {}", "  open() {}"].join("\n"),
		);
		expect(
			methods.map((method) => [method.name, method.visibility]).sort(),
		).toEqual([
			["open", "public"],
			["shared", "protected"],
		]);
	});

	// `apply = async () => {}` is callable exactly like a method and is the usual
	// way to bind `this`. Dropping it hid a whole style of page object.
	it("reports an arrow-function class property as a method", () => {
		const methods = methodsOf(
			"  apply = async (code: string): Promise<void> => { void code; };",
		);
		expect(methods[0]).toMatchObject({
			name: "apply",
			kind: "method",
			isAsync: true,
			declaredAsProperty: true,
			signature: "apply(code: string): Promise<void>",
			returnType: "Promise<void>",
		});
	});

	it("keeps a plain data field out of the method list", () => {
		const methods = methodsOf(
			["  count = 0;", "  label: string = 'x';"].join("\n"),
		);
		expect(methods).toEqual([]);
	});

	it("flags a static arrow property as static", () => {
		const methods = methodsOf("  static make = () => 1;");
		expect(methods[0]).toMatchObject({
			name: "make",
			isStatic: true,
			declaredAsProperty: true,
		});
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

	// A base class's helpers really are on every subclass's prototype. Reporting
	// only the subclass's own made the surface a subset of the truth, and an
	// agent that cannot see `fromBase` writes a second one.
	it("lists project-local base-class methods by default", () => {
		const fixture = inheritanceFixture();
		const byDefault = readMethods(fixture.cls, fixture.imports, fixture.ctx);
		expect(byDefault.map((method) => method.name).sort()).toEqual([
			"fromBase",
			"own",
		]);
		const base = byDefault.find((method) => method.name === "fromBase");
		expect(base).toMatchObject({ inherited: true, declaredIn: "Base" });
		expect(
			byDefault.find((method) => method.name === "own")?.inherited,
		).toBeUndefined();
	});

	it("returns only the class's own methods when asked", () => {
		const fixture = inheritanceFixture();
		const own = readMethods(fixture.cls, fixture.imports, fixture.ctx, {
			includeInherited: false,
		});
		expect(own.map((method) => method.name)).toEqual(["own"]);
	});

	// The prototype chain does not care about `private`: an own member of that
	// name is what a call resolves to, and it does not compile. Reporting the
	// base's public one would advertise a call that fails to typecheck.
	it("lets a private subclass override shadow a public base method", () => {
		const fixture = inheritanceFixture("  private fromBase() {}");
		const methods = readMethods(fixture.cls, fixture.imports, fixture.ctx);
		expect(methods.map((method) => method.name)).toEqual([]);
	});

	it("still shadows with a public override, reporting it once", () => {
		const fixture = inheritanceFixture("  fromBase(): void {}");
		const methods = readMethods(fixture.cls, fixture.imports, fixture.ctx);
		expect(methods.map((method) => method.name)).toEqual(["fromBase"]);
		expect(methods[0].inherited).toBeUndefined();
		expect(methods[0].signature).toBe("fromBase(): void");
	});

	it("does not let a subclass static shadow an inherited instance method", () => {
		// `static fromBase()` is on the constructor; the base's `fromBase()` is on
		// the prototype. Instances still inherit the base method, so keying the
		// shadow set on the name alone dropped callable instance API from the tree.
		const fixture = inheritanceFixture("  static fromBase() {}");
		const methods = readMethods(fixture.cls, fixture.imports, fixture.ctx);
		expect(
			methods.map(
				(method) => `${method.isStatic ? "static " : ""}${method.name}`,
			),
		).toEqual(["static fromBase", "fromBase"]);
		expect(methods[1].inherited).toBe(true);
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

describe("readMethods and TypeScript overloads", () => {
	/**
	 * Overloading and shadowing are different relations that happen to share a
	 * name. One `seen` set conflated them: the first signature marked the name,
	 * and every later one was dropped as though a subclass had hidden a base
	 * member - so the tree offered one call shape out of N and an agent writing
	 * against the others got no support for them.
	 */
	it("reports every overload signature", () => {
		const methods = methodsOf(
			[
				"  find(name: string): number;",
				"  find(id: number): number;",
				"  find(x: string | number): number { return Number(x); }",
			].join("\n"),
		);
		expect(methods.map((one) => one.name)).toEqual(["find", "find"]);
		const signatures = methods.map((one) => one.signature).join(" | ");
		expect(signatures).toContain("name: string");
		expect(signatures).toContain("id: number");
	});

	it("leaves the implementation signature out", () => {
		// TypeScript resolves calls against the overloads alone, so offering the
		// implementation would be offering a call shape the compiler refuses.
		const methods = methodsOf(
			[
				"  find(name: string): number;",
				"  find(id: number): number;",
				"  find(x: string | number): number { return Number(x); }",
			].join("\n"),
		);
		expect(methods).toHaveLength(2);
		expect(methods.map((one) => one.signature).join(" | ")).not.toContain(
			"string | number",
		);
	});

	it("still reports a plain method once", () => {
		const methods = methodsOf("  find(name: string): number { return 1; }");
		expect(methods).toHaveLength(1);
	});
});
