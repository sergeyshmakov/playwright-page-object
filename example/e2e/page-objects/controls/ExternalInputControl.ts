import type { Locator } from "@playwright/test";

/**
 * An external input control that accepts the locator as a constructor argument.
 * Compatible with selector decorators that pass the constructor as metadata.
 * Does NOT extend `PageObject`.
 */
export class ExternalInputControl {
	constructor(private readonly _locator: Locator) {}

	get locator(): Locator {
		return this._locator;
	}

	async fill(value: string) {
		await this._locator.fill(value);
	}

	async expectVisible() {
		const { expect } = await import("@playwright/test");
		await expect(this._locator).toBeVisible();
	}
}
