import type { Page } from "@playwright/test";

/**
 * Map of fixture names to PageObject constructors.
 * Each constructor receives `page` as the first argument.
 */
export type PageObjectConstructorsMap = Record<
	string,
	new (
		page: Page,
		...args: any[]
	) => any
>;

/**
 * Fixture types derived from a constructors map.
 * Maps each key to the instance type of its constructor.
 */
export type FixturesFromMap<T extends PageObjectConstructorsMap> = {
	[K in keyof T]: InstanceType<T[K]>;
};

/**
 * Creates Playwright fixtures from a map of PageObject classes.
 * Each fixture instantiates its PageObject with `page` and passes it to the test.
 *
 * @param pageObjects - Record of fixture name → PageObject constructor
 * @returns Fixtures object for use with `test.extend()`
 *
 * @example
 * ```ts
 * const test = base.extend(createFixtures({
 *   homePage: HomePage,
 *   settingsPage: SettingsPage,
 * }));
 *
 * test("check header", async ({ homePage }) => {
 *   await homePage.expect().toBeVisible();
 * });
 * ```
 */
export function createFixtures<T extends PageObjectConstructorsMap>(
	pageObjects: T,
) {
	const fixtures: any = {};

	for (const [key, PageObjectClass] of Object.entries(pageObjects)) {
		fixtures[key] = async (
			{ page }: { page: Page },
			use: (r: InstanceType<typeof PageObjectClass>) => Promise<void>,
		) => {
			const instance = new PageObjectClass(page);
			await use(instance);
		};
	}

	return fixtures as {
		[K in keyof T]: (
			args: { page: Page },
			use: (r: InstanceType<T[K]>) => Promise<void>,
		) => Promise<void>;
	};
}
