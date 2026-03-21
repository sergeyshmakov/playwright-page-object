import { test as base } from "@playwright/test";
import { createFixtures } from "playwright-page-object";
import { CheckoutPage } from "./page-objects/CheckoutPage";
import { ExternalCheckoutPage } from "./page-objects/ExternalCheckoutPage";
import { PlainHostCheckoutPage } from "./page-objects/PlainHostCheckoutPage";

export const test = base.extend<{
	checkoutPage: CheckoutPage;
	externalCheckoutPage: ExternalCheckoutPage;
	plainHostCheckoutPage: PlainHostCheckoutPage;
}>(
	createFixtures({
		checkoutPage: CheckoutPage,
		externalCheckoutPage: ExternalCheckoutPage,
		plainHostCheckoutPage: PlainHostCheckoutPage,
	}),
);
