import type { Locator } from "@playwright/test";

/**
 * Internal symbol key used by decorators to store a resolved `Locator`
 * on decorated root/page object instances.
 *
 * Registered via `Symbol.for` so two loaded copies of the library (e.g. the
 * CJS and ESM builds in one process) agree on the same key.
 */
export const LOCATOR_SYMBOL: unique symbol = Symbol.for(
	"playwright-page-object/locator",
);

/**
 * Prototype brand carried by `PageObject` (and subclasses). Lets the static
 * type guards recognize instances/classes coming from another loaded copy of
 * the library, where `instanceof` would fail.
 */
export const PAGE_OBJECT_BRAND: unique symbol = Symbol.for(
	"playwright-page-object/page-object",
);

/** Prototype brand carried by `RootPageObject` (and subclasses). */
export const ROOT_PAGE_OBJECT_BRAND: unique symbol = Symbol.for(
	"playwright-page-object/root-page-object",
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
