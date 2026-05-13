import type { Fixtures, Page } from "@playwright/test";

type EmptyFixtures = Record<string, never>;

type PageObjectConstructor<T> = new (page: Page) => T;
type PageObjectFactory<T> = (page: Page) => T;
type PageObjectEntry<T> = PageObjectConstructor<T> | PageObjectFactory<T>;

/**
 * Map of fixture names to PageObject constructors or factory functions.
 * Each entry receives `page` and returns a page object instance.
 *
 * - **Class constructor**: `CheckoutPage` — called as `new CheckoutPage(page)`
 * - **Factory function**: `(page) => new AuthPage(page, config)` — called directly
 */
export type PageObjectConstructorsMap = Record<
	string,
	PageObjectEntry<unknown>
>;

/** Maps constructor/factory map to instance types for Fixtures. */
export type FixturesFromMap<T extends PageObjectConstructorsMap> = {
	[K in keyof T]: T[K] extends PageObjectEntry<infer U> ? U : never;
};

/**
 * Creates Playwright fixtures from a map of PageObject classes or factory functions.
 * Each fixture instantiates its PageObject with `page` and passes it to the test.
 *
 * Returns Playwright's `Fixtures` type. Pass the generic to `extend` for typed fixtures:
 * `base.extend<{ checkoutPage: CheckoutPage }>(createFixtures({ checkoutPage: CheckoutPage }))`
 *
 * @param pageObjects - Record of fixture name → PageObject constructor or factory
 * @returns Fixtures object for use with `test.extend()`
 *
 * @example Class constructor (most common)
 * ```ts
 * const test = base.extend<{ homePage: HomePage }>(
 *   createFixtures({ homePage: HomePage })
 * );
 * ```
 *
 * @example Factory function (when extra constructor args are needed)
 * ```ts
 * const test = base.extend<{ authPage: AuthPage }>(
 *   createFixtures({ authPage: (page) => new AuthPage(page, authConfig) })
 * );
 * ```
 *
 * @example Mixed
 * ```ts
 * const test = base.extend<{ homePage: HomePage; authPage: AuthPage }>(
 *   createFixtures({
 *     homePage: HomePage,
 *     authPage: (page) => new AuthPage(page, authConfig),
 *   })
 * );
 * ```
 */
export function createFixtures<T extends PageObjectConstructorsMap>(
	pageObjects: T,
): Fixtures<FixturesFromMap<T>, EmptyFixtures, EmptyFixtures, EmptyFixtures> {
	const fixtures: Record<
		string,
		(args: { page: Page }, use: (r: unknown) => Promise<void>) => Promise<void>
	> = {};

	for (const [key, entry] of Object.entries(pageObjects)) {
		fixtures[key] = async (
			{ page }: { page: Page },
			use: (r: unknown) => Promise<void>,
		) => {
			const isConstructor =
				typeof entry === "function" &&
				entry.prototype !== undefined &&
				entry.prototype.constructor === entry;

			const instance = isConstructor
				? new (entry as PageObjectConstructor<unknown>)(page)
				: (entry as PageObjectFactory<unknown>)(page);

			await use(instance);
		};
	}

	return fixtures as Fixtures<
		FixturesFromMap<T>,
		EmptyFixtures,
		EmptyFixtures,
		EmptyFixtures
	>;
}
