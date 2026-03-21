import { test } from "./fixtures";

test.beforeEach(async ({ page }) => {
	await page.goto("/");
});

test("plain host with `page` applies promo like RootPageObject checkout", async ({
	plainHostCheckoutPage,
}) => {
	await plainHostCheckoutPage.PromoCodeInput.fill("SAVE20");
	await plainHostCheckoutPage.ApplyPromoButton.$.click();

	await plainHostCheckoutPage.expectCartHasItemCount(3);
});

test("plain host removes first row via raw @ListSelector Locator", async ({
	plainHostCheckoutPage,
}) => {
	await plainHostCheckoutPage.PromoCodeInput.fill("SAVE20");
	await plainHostCheckoutPage.ApplyPromoButton.$.click();
	await plainHostCheckoutPage.CartItemRows.nth(0).getByTestId("Remove").click();
	await plainHostCheckoutPage.expectCartHasItemCount(2);
});

test("plain host fragment nests @Selector under `this.locator`", async ({
	plainHostCheckoutPage,
}) => {
	await plainHostCheckoutPage.PromoSection.PromoInput.fill("SAVE20");
	await plainHostCheckoutPage.ApplyPromoButton.$.click();

	await plainHostCheckoutPage.expectCartHasItemCount(3);
});
