import type { Locator } from "@playwright/test";

/**
 * An example of an external control that does NOT extend `PageObject`.
 * The selector decorator constructs it with the resolved locator.
 */
export class ExternalButtonControl {
	constructor(private readonly _locator: Locator) {}

	/** The resolved Playwright locator for this button. */
	get locator(): Locator {
		return this._locator;
	}

	async click() {
		await this.locator.click();
	}

	async expectVisible() {
		const { expect } = await import("@playwright/test");
		await expect(this.locator).toBeVisible();
	}
}
