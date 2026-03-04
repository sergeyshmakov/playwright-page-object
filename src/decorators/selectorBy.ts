import type { Locator } from "@playwright/test";
import type { PageObject } from "../page-objects/PageObject";

/**
 * Accessor decorator for custom selector logic. Transforms the accessor value
 * using a function that receives the root locator and the accessor's return value.
 *
 * Use when built-in selectors (`Selector`, `SelectorByText`, etc.) are insufficient.
 *
 * @param selector - Function `(root, value) => value` that returns a locator or PageObject
 *
 * @example
 * ```ts
 * @RootSelector("sidebar")
 * class Sidebar extends PageObject {
 *   @SelectorBy((root, id) => root.getByTestId(id))
 *   accessor link = "nav-link" as string;
 * }
 * ```
 */
export function SelectorBy<TSelectorValue>(
	selector: (root: Locator, value: TSelectorValue) => TSelectorValue,
) {
	return function <TThis extends PageObject, TValue extends TSelectorValue>(
		target: ClassAccessorDecoratorTarget<TThis, TValue>,
		context: ClassAccessorDecoratorContext<TThis, TValue>,
	) {
		const { get } = target;
		const { kind } = context;

		if (kind === "accessor") {
			return {
				get() {
					const value = get.call(this);
					const root = (this as unknown as { locator: Locator }).locator;
					return selector(root, value);
				},
			} as ClassAccessorDecoratorResult<TThis, TValue>;
		}
		throw new Error(
			`[SelectorBy] Decorator SelectorBy... can be used only with accessor class element, but used with "${kind}" kind`,
		);
	};
}
