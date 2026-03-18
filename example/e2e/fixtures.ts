import { test as base } from "@playwright/test";
import { createFixtures } from "playwright-page-object";
import { CheckoutPage } from "./page-objects/CheckoutPage";
import { ExternalCheckoutPage } from "./page-objects/ExternalCheckoutPage";

export const test = base.extend<{
	checkoutPage: CheckoutPage;
	externalCheckoutPage: ExternalCheckoutPage;
}>(
	createFixtures({
		checkoutPage: CheckoutPage,
		externalCheckoutPage: ExternalCheckoutPage,
	}),
);
