import type { Locator } from "@playwright/test";
import { LOCATOR_SYMBOL } from "../protocol";

function resolveLocator(instance: object): Locator {
	if (LOCATOR_SYMBOL in instance) {
		return (instance as Record<typeof LOCATOR_SYMBOL, Locator>)[LOCATOR_SYMBOL];
	}

	throw new Error(
		"[SelectorBy] Cannot resolve locator: the class does not implement the context protocol (LOCATOR_SYMBOL). " +
			"Make sure to apply a @RootSelector decorator before using child selector decorators.",
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
