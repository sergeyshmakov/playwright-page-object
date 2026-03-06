import { test } from "./fixtures";

test.beforeEach(async ({ page }) => {
	await page.goto("/");
});

test("should apply promo code and remove first item", async ({
	checkoutPage,
}) => {
	await checkoutPage.applyPromoCode("SAVE20");

	const firstItem = checkoutPage.CartItems.items[0];
	await firstItem.RemoveButton.$.click();

	await checkoutPage.expectCartHasItemCount(2);
});

test("should empty cart by removing all items", async ({ checkoutPage }) => {
	const count = await checkoutPage.CartItems.count();
	for (let i = 0; i < count; i++) {
		const item = checkoutPage.CartItems.items[0];
		await item.RemoveButton.$.click();
	}
	await checkoutPage.expectCartEmpty();
});

test("should iterate over cart items with for await", async ({
	checkoutPage,
}) => {
	for await (const item of checkoutPage.CartItems.items) {
		await item.expect({ soft: true }).toBeVisible();
	}
});

test("should find item by text using filterByText and remove it", async ({
	checkoutPage,
}) => {
	const widgetB = checkoutPage.CartItems.filterByText("Widget B");
	await widgetB.waitVisible();
	await widgetB.RemoveButton.$.click();
	await checkoutPage.expectCartHasItemCount(2);
});

test("should use filterByText to get matching items", async ({
	checkoutPage,
}) => {
	const widgetItems = checkoutPage.CartItems.filterByText("Widget");
	await widgetItems.expect().toHaveCount(2);
});
