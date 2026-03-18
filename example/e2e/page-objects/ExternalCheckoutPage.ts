import type { Page } from "@playwright/test";
import {
	RootSelector,
	Selector,
	SelectorByRole,
} from "playwright-page-object";
import { ExternalButtonControl } from "./controls/ExternalButtonControl";
import { ExternalInputControl } from "./controls/ExternalInputControl";

/**
 * Demonstrates a root page object that does NOT extend `PageObject`.
 *
 * The class has the standard Playwright POM constructor `(page: Page)`.
 * `@RootSelector` wires the page object context automatically, so `this.page`
 * is fully preserved on the class itself.
 *
 * Child selector decorators then construct external controls from the resolved
 * locator using the trailing constructor/factory argument.
 *
 * Two child control patterns shown:
 * 1. Constructor as the last decorator arg
 * 2. Factory function as the last decorator arg
 */
@RootSelector("CheckoutPage")
export class ExternalCheckoutPage {
	constructor(readonly page: Page) {}

	/**
	 * Constructor signature.
	 * `new ExternalInputControl(resolvedLocator)` is called at access time.
	 */
	@Selector("PromoCodeInput", ExternalInputControl)
	accessor PromoCode = undefined as unknown as ExternalInputControl;

	/**
	 * Factory function signature.
	 * Useful when the construction logic should stay inline with the selector.
	 */
	@SelectorByRole("button", { name: "Apply" }, (locator) => new ExternalButtonControl(locator))
	accessor ApplyPromoButton = undefined as unknown as ExternalButtonControl;

	/**
	 * Constructor signature again, with a different selector.
	 */
	@SelectorByRole("button", { name: "Remove" }, ExternalButtonControl)
	accessor FirstRemoveButton = undefined as unknown as ExternalButtonControl;

	async applyPromoCode(code: string) {
		await this.PromoCode.fill(code);
		await this.ApplyPromoButton.locator.click();
	}
}
