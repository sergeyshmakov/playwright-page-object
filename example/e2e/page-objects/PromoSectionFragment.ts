import type { Locator } from "@playwright/test";
import { Selector } from "playwright-page-object";

/**
 * Fragment control: receives the section root from `@Selector("PromoSection", …)` and
 * nests child selectors under `this.locator` (no `PageObject` / `LOCATOR_SYMBOL`).
 */
export class PromoSectionFragment {
	constructor(readonly locator: Locator) {}

	@Selector("PromoCodeInput")
	accessor PromoInput!: Locator;
}
