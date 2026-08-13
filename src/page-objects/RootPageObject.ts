import type { Locator, Page } from "@playwright/test";
import { ROOT_PAGE_OBJECT_BRAND } from "../protocol";
import { PageObject, type SelectorType } from "./PageObject";

/**
 * Constructor signature for top-level root page objects.
 * The first constructor argument is always Playwright `Page`.
 */
export type RootPageObjectConstructor<
	TRootPageObject extends RootPageObject = RootPageObject,
	TRest extends unknown[] = unknown[],
> = new (page: Page, ...rest: TRest) => TRootPageObject;

/**
 * Base class for top-level page objects that use `@RootSelector...`.
 *
 * Use `RootPageObject` for root-decorated classes created directly from Playwright `Page`.
 * Use `PageObject` for nested child controls created by selector decorators.
 */
export class RootPageObject extends PageObject {
	constructor(page: Page) {
		void page;
		super();
	}

	/** Cross-copy brand: lives on the prototype, inherited by all subclasses. */
	get [ROOT_PAGE_OBJECT_BRAND](): true {
		return true;
	}

	static isRootClass<TArgs extends [Page, ...unknown[]]>(
		value?: unknown,
	): value is new (
		...args: TArgs
	) => RootPageObject {
		if (typeof value !== "function") {
			return false;
		}
		if (value.prototype instanceof RootPageObject) {
			return true;
		}
		// Fallback for classes from another loaded copy of the library. The
		// brand getter is an own property of RootPageObject.prototype itself,
		// so requiring an inherited (non-own) brand keeps the guard strict:
		// it matches proper subclasses only, mirroring `prototype instanceof`.
		const proto: unknown = value.prototype;
		return (
			typeof proto === "object" &&
			proto !== null &&
			ROOT_PAGE_OBJECT_BRAND in proto &&
			!Object.hasOwn(proto, ROOT_PAGE_OBJECT_BRAND)
		);
	}

	override cloneWithContext(root: Locator, selector: SelectorType): this {
		void root;
		void selector;

		throw new Error(
			`[RootPageObject] ${this.constructor.name} cannot be used as a nested child. Extend PageObject for nested controls.`,
		);
	}
}
