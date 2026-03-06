import { test as base } from "@playwright/test";
import { createFixtures } from "playwright-page-object";
import { CheckoutPage } from "./page-objects/CheckoutPage";

export const test = base.extend<{ checkoutPage: CheckoutPage }>(
	createFixtures({
		checkoutPage: CheckoutPage,
	}),
);
