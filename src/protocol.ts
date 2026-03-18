/**
 * Internal symbol key used by decorators to store a resolved `Locator`
 * on decorated root/page object instances.
 */
export const LOCATOR_SYMBOL: unique symbol = Symbol(
	"playwright-page-object/locator",
);
