import type { Fixtures, Page } from "@playwright/test";

type EmptyFixtures = Record<string, never>;

/**
 * Map of fixture names to PageObject constructors.
 * Each constructor receives `page` as the first argument.
 */
export type PageObjectConstructorsMap = Record<
	string,
	new (
		page: Page,
	) => unknown
>;

/** Maps constructor map to instance types for Fixtures. */
export type FixturesFromMap<T extends PageObjectConstructorsMap> = {
	[K in keyof T]: InstanceType<T[K]>;
};

/**
 * Creates Playwright fixtures from a map of PageObject classes.
 * Each fixture instantiates its PageObject with `page` and passes it to the test.
 *
 * Returns Playwright's `Fixtures` type. Pass the generic to `extend` for typed fixtures:
 * `base.extend<{ checkoutPage: CheckoutPage }>(createFixtures({ checkoutPage: CheckoutPage }))`
 *
 * @param pageObjects - Record of fixture name → PageObject constructor
 * @returns Fixtures object for use with `test.extend()`
 *
 * @example
 * ```ts
 * const test = base.extend<{ homePage: HomePage; settingsPage: SettingsPage }>(
 *   createFixtures({ homePage: HomePage, settingsPage: SettingsPage })
 * );
 * test("check header", async ({ homePage }) => {
 *   await homePage.expect().toBeVisible();
 * });
 * ```
 */
export function createFixtures<T extends PageObjectConstructorsMap>(
	pageObjects: T,
): Fixtures<FixturesFromMap<T>, EmptyFixtures, EmptyFixtures, EmptyFixtures> {
	const fixtures: Record<
		string,
		(args: { page: Page }, use: (r: unknown) => Promise<void>) => Promise<void>
	> = {};

	for (const [key, PageObjectClass] of Object.entries(pageObjects)) {
		fixtures[key] = async (
			{ page }: { page: Page },
			use: (r: unknown) => Promise<void>,
		) => {
			const instance = new (PageObjectClass as new (page: Page) => unknown)(
				page,
			);
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
