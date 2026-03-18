import { test } from "./fixtures";

/**
 * E2E tests demonstrating external controls (not extending PageObject)
 * used via trailing constructor/factory decorator metadata.
 */

test.beforeEach(async ({ page }) => {
	await page.goto("/");
});

test("constructor/factory metadata — PromoCode fills and Apply button clicks via external controls", async ({
	externalCheckoutPage,
}) => {
	// PromoCode uses ExternalInputControl as the trailing decorator argument.
	await externalCheckoutPage.PromoCode.fill("SAVE20");

	// ApplyPromoButton uses a trailing factory function.
	await externalCheckoutPage.ApplyPromoButton.locator.click();
});

test("constructor metadata — ExternalButtonControl is constructed with the resolved locator", async ({
	externalCheckoutPage,
}) => {
	// We use .first() since there are multiple Remove buttons on the page.
	await externalCheckoutPage.FirstRemoveButton.locator
		.first()
		.waitFor({ state: "visible" });
	await externalCheckoutPage.FirstRemoveButton.locator.first().click();
});

test("applyPromoCode helper uses both external control creation paths", async ({
	externalCheckoutPage,
}) => {
	await externalCheckoutPage.applyPromoCode("DISCOUNT10");
});
