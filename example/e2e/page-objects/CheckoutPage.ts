import type { Locator } from "@playwright/test";
import {
	ListPageObject,
	ListStrictSelector,
	PageObject,
	RootPageObject,
	RootSelector,
	Selector,
	SelectorByRole,
} from "playwright-page-object";
import { CartItemControl } from "./CartItemControl";
import { ButtonControl } from "./controls/ButtonControl";

@RootSelector("CheckoutPage")
export class CheckoutPage extends RootPageObject {
	/** PageObject approach: use PromoCode.$.fill() */
	@Selector("PromoCodeInput")
	accessor PromoCode = new PageObject();

	/** Locator approach: use PromoCodeInput.fill() directly when you can't use PageObject yet */
	@Selector("PromoCodeInput")
	accessor PromoCodeInput!: Locator;

	@SelectorByRole("button", { name: "Apply" })
	accessor ApplyPromoButton = new ButtonControl();

	@ListStrictSelector("CartItem")
	accessor CartItems = new ListPageObject(CartItemControl);

	/** List without custom item type — items are plain PageObject instances */
	@ListStrictSelector("CartItem")
	accessor CartItemsAsPlainList = new ListPageObject();

	async applyPromoCode(code: string) {
		await this.PromoCode.$.fill(code);
		await this.ApplyPromoButton.$.click();
	}

	async expectCartEmpty() {
		await this.CartItems.waitCount(0);
	}

	async expectCartHasItemCount(n: number) {
		await this.CartItems.waitCount(n);
	}
}
