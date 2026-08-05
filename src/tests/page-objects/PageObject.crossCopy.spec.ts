import { describe, expect, it } from "vitest";
import { PageObject } from "../../page-objects/PageObject";
import { RootPageObject } from "../../page-objects/RootPageObject";
import { LOCATOR_SYMBOL } from "../../protocol";

/**
 * With the package exposing both CJS and ESM builds, one process can hold two
 * copies of the library. These tests simulate classes coming from "the other
 * copy": they do not inherit from our PageObject, but carry the well-known
 * `Symbol.for` brands on their prototype chain the same way the real classes
 * do.
 */

const FOREIGN_PAGE_OBJECT_BRAND = Symbol.for(
	"playwright-page-object/page-object",
);
const FOREIGN_ROOT_BRAND = Symbol.for(
	"playwright-page-object/root-page-object",
);

class ForeignPageObject {
	get [FOREIGN_PAGE_OBJECT_BRAND](): true {
		return true;
	}
}

class ForeignControl extends ForeignPageObject {}

class ForeignRootPageObject extends ForeignPageObject {
	get [FOREIGN_ROOT_BRAND](): true {
		return true;
	}
}

class ForeignCheckoutPage extends ForeignRootPageObject {}

describe("cross-copy identity", () => {
	it("registers the locator protocol symbol globally", () => {
		expect(LOCATOR_SYMBOL).toBe(Symbol.for("playwright-page-object/locator"));
	});

	describe("PageObject.isClass", () => {
		it("accepts local subclasses (fast path)", () => {
			class Local extends PageObject {}
			expect(PageObject.isClass(Local)).toBe(true);
			expect(PageObject.isClass(PageObject)).toBe(true);
		});

		it("accepts branded classes from another copy", () => {
			expect(PageObject.isClass(ForeignPageObject)).toBe(true);
			expect(PageObject.isClass(ForeignControl)).toBe(true);
		});

		it("rejects unbranded classes and non-functions", () => {
			class Unrelated {}
			expect(PageObject.isClass(Unrelated)).toBe(false);
			expect(PageObject.isClass(undefined)).toBe(false);
			expect(PageObject.isClass({})).toBe(false);
		});
	});

	describe("PageObject.isInstance", () => {
		it("accepts local instances (fast path)", () => {
			expect(PageObject.isInstance(new PageObject())).toBe(true);
		});

		it("accepts branded instances from another copy", () => {
			expect(PageObject.isInstance(new ForeignControl())).toBe(true);
		});

		it("rejects unbranded values", () => {
			expect(PageObject.isInstance({})).toBe(false);
			expect(PageObject.isInstance(null)).toBe(false);
			expect(PageObject.isInstance("PageObject")).toBe(false);
		});
	});

	describe("RootPageObject.isRootClass", () => {
		it("accepts local subclasses but not RootPageObject itself", () => {
			class LocalRoot extends RootPageObject {}
			expect(RootPageObject.isRootClass(LocalRoot)).toBe(true);
			expect(RootPageObject.isRootClass(RootPageObject)).toBe(false);
		});

		it("accepts branded subclasses from another copy", () => {
			expect(RootPageObject.isRootClass(ForeignCheckoutPage)).toBe(true);
		});

		it("rejects the other copy's RootPageObject base itself", () => {
			// Mirrors `prototype instanceof RootPageObject`: the base class owns
			// the brand getter, so it must not count as its own subclass.
			expect(RootPageObject.isRootClass(ForeignRootPageObject)).toBe(false);
		});

		it("rejects plain PageObject-branded classes", () => {
			expect(RootPageObject.isRootClass(ForeignControl)).toBe(false);
		});
	});
});
