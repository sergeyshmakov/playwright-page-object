import type { Locator, Page } from "@playwright/test";
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

	static isRootClass<TArgs extends [Page, ...unknown[]]>(
		value?: unknown,
	): value is new (
		...args: TArgs
	) => RootPageObject {
		return (
			typeof value === "function" && value.prototype instanceof RootPageObject
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
