import type { Locator } from "@playwright/test";

/**
 * Internal symbol key used by decorators to store a resolved `Locator`
 * on decorated root/page object instances.
 */
export const LOCATOR_SYMBOL: unique symbol = Symbol(
	"playwright-page-object/locator",
);

/** Internal duck-type check for Playwright Locator-like values. */
export function isLocatorLike(
	value: object,
): value is Pick<Locator, "locator" | "page"> {
	return (
		"locator" in value &&
		typeof (value as { locator?: unknown }).locator === "function" &&
		"page" in value &&
		typeof (value as { page?: unknown }).page === "function"
	);
}
