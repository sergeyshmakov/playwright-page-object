import type { Locator, Page } from "@playwright/test";
import {
	ListPageObject,
	ListSelector,
	PageObject,
	Selector,
	SelectorByRole,
} from "playwright-page-object";
import { CartItemControl } from "./CartItemControl";
import { ButtonControl } from "./controls/ButtonControl";
import { PromoSectionFragment } from "./PromoSectionFragment";

/**
 * Same controls as {@link CheckoutPage}, but the host is a plain class with
 * `readonly page` only — no `RootPageObject` / `@RootSelector`. Selectors resolve
 * from `page.locator("body")`. Includes {@link PromoSectionFragment} to show nested
 * `@Selector*` under `this.locator`.
 */
export class PlainHostCheckoutPage {
	constructor(readonly page: Page) {}

	@Selector("PromoCodeInput")
	accessor PromoCode = new PageObject();

	@Selector("PromoCodeInput")
	accessor PromoCodeInput!: Locator;

	@Selector("PromoSection", PromoSectionFragment)
	accessor PromoSection!: PromoSectionFragment;

	@SelectorByRole("button", { name: "Apply" })
	accessor ApplyPromoButton = new ButtonControl();

	@ListSelector("CartItem_")
	accessor CartItems = new ListPageObject(CartItemControl);

	/** Raw Playwright locator for all cart rows (no ListPageObject) */
	@ListSelector("CartItem_")
	accessor CartItemRows!: Locator;

	async applyPromoCode(code: string) {
		await this.PromoCode.$.fill(code);
		await this.ApplyPromoButton.$.click();
	}

	async expectCartHasItemCount(n: number) {
		await this.CartItems.waitCount(n);
	}
}
