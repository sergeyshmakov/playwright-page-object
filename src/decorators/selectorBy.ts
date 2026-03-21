import type { Locator, Page } from "@playwright/test";
import { isLocatorLike, LOCATOR_SYMBOL } from "../protocol";

/**
 * Fragment / factory controls often use `constructor(readonly locator: Locator)`.
 * When there is no LOCATOR_SYMBOL, that Locator becomes the parent for nested `@Selector*`.
 */
function getDataPropertyValue(instance: object, key: PropertyKey): unknown {
	let current: object | null = instance;
	while (current !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(current, key);
		if (descriptor !== undefined) {
			return "value" in descriptor ? descriptor.value : undefined;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

function tryHostLocatorRoot(instance: object): Locator | undefined {
	const loc = getDataPropertyValue(instance, "locator");
	if (typeof loc === "object" && loc !== null && isLocatorLike(loc)) {
		return loc as Locator;
	}
	return undefined;
}

/**
 * When the host has no LOCATOR_SYMBOL but exposes Playwright `Page` as `page`,
 * use `page.locator("body")` as the chain root (same default scope as `@RootSelector()`).
 */
function tryHostPageBodyRoot(instance: object): Locator | undefined {
	const page = getDataPropertyValue(instance, "page");
	if (
		typeof page === "object" &&
		page !== null &&
		"locator" in page &&
		typeof (page as { locator?: unknown }).locator === "function" &&
		!isLocatorLike(page)
	) {
		return (page as Page).locator("body");
	}
	return undefined;
}

function resolveLocator(instance: object): Locator {
	if (LOCATOR_SYMBOL in instance) {
		return (instance as Record<typeof LOCATOR_SYMBOL, Locator>)[LOCATOR_SYMBOL];
	}

	const locatorRoot = tryHostLocatorRoot(instance);
	if (locatorRoot !== undefined) {
		return locatorRoot;
	}

	const bodyRoot = tryHostPageBodyRoot(instance);
	if (bodyRoot !== undefined) {
		return bodyRoot;
	}

	throw new Error(
		"[SelectorBy] Cannot resolve locator: the class does not implement the context protocol (LOCATOR_SYMBOL), " +
			"and has no Locator-like `locator` property, and has no Playwright `page` property. Use @RootSelector / " +
			"RootPageObject, add `readonly locator: Locator` (fragment from @Selector factory), or `readonly page: Page`.",
	);
}

/**
 * Accessor decorator for custom selector logic. Transforms the accessor value
 * using a function that receives the root locator and the accessor's return value.
 *
 * Use when built-in selectors (`Selector`, `SelectorByText`, etc.) are insufficient.
 *
 * @param selector - Function `(root, value) => value` that returns a locator or PageObject
 *
 * @example RootPageObject + @RootSelector
 * ```ts
 * @RootSelector("sidebar")
 * class Sidebar extends PageObject {
 *   @SelectorBy((root, id) => root.getByTestId(id))
 *   accessor link = "nav-link" as string;
 * }
 * ```
 *
 * @example Plain host with `page` (no @RootSelector)
 * ```ts
 * class Checkout {
 *   constructor(readonly page: Page) {}
 *   @Selector("promo")
 *   accessor promo!: Locator;
 * }
 * ```
 *
 * @example Fragment with `locator` (from `@Selector(..., Factory)`)
 * ```ts
 * class Section {
 *   constructor(readonly locator: Locator) {}
 *   @Selector("field")
 *   accessor field!: Locator;
 * }
 * ```
 */
export function SelectorBy<TSelectorValue>(
	selector: (root: Locator, value: TSelectorValue) => TSelectorValue,
) {
	return function <TThis extends object, TValue extends TSelectorValue>(
		target: ClassAccessorDecoratorTarget<TThis, TValue>,
		context: ClassAccessorDecoratorContext<TThis, TValue>,
	) {
		const { get } = target;
		const { kind } = context;

		if (kind === "accessor") {
			return {
				get() {
					const value = get.call(this);
					const root = resolveLocator(this as object);
					return selector(root, value);
				},
			} as ClassAccessorDecoratorResult<TThis, TValue>;
		}
		throw new Error(
			`[SelectorBy] Decorator SelectorBy... can be used only with accessor class element, but used with "${kind}" kind`,
		);
	};
}
