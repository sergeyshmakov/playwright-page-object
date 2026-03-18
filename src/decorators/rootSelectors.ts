import type { Locator, Page } from "@playwright/test";
import { PageObject, type SelectorType } from "../page-objects/PageObject";
import { RootPageObject } from "../page-objects/RootPageObject";
import { LOCATOR_SYMBOL } from "../protocol";

// biome-ignore lint/suspicious/noExplicitAny: broad constructor helper is required for decorator typing
type AnyConstructor = new (...args: any[]) => object;
type PageFirstConstructor<TClass extends AnyConstructor> =
	ConstructorParameters<TClass> extends [Page, ...unknown[]] ? TClass : never;
type PageFirstArgs<TClass extends AnyConstructor> =
	ConstructorParameters<TClass> extends [Page, ...infer TRest]
		? [page: Page, ...rest: TRest]
		: never;

function resolvePage(value: unknown, className: string): Page {
	if (
		typeof value === "object" &&
		value !== null &&
		"locator" in value &&
		typeof (value as { locator?: unknown }).locator === "function"
	) {
		return value as Page;
	}

	throw new Error(
		`[RootSelector] ${className || "Decorated class"} must receive Playwright Page as the first constructor argument.`,
	);
}

function RootSelectorBy(selector: SelectorType) {
	return function <TClass extends AnyConstructor>(
		target: PageFirstConstructor<TClass>,
		context: ClassDecoratorContext<TClass>,
	): TClass {
		type TArgs = PageFirstArgs<TClass>;
		const { kind } = context;

		if (kind === "class") {
			if (RootPageObject.isRootClass(target)) {
				const Base = target as unknown as new (
					...args: TArgs
				) => RootPageObject;

				return class extends Base {
					constructor(...args: TArgs) {
						const page = resolvePage(args[0], target.name);
						super(...args);
						this.page = page;
						this.root = page.locator("body");
						this.selector = selector;
					}
				} as unknown as TClass;
			}

			if (PageObject.isClass(target)) {
				throw new Error(
					`[RootSelector] ${target.name || "Decorated class"} must extend RootPageObject to use root decorators. Extend PageObject only for nested child controls.`,
				);
			}

			const Base = target as unknown as new (...args: TArgs) => object;

			return class extends Base {
				constructor(...args: TArgs) {
					const page = resolvePage(args[0], target.name);
					super(...args);
					const root = page.locator("body");
					(this as unknown as Record<typeof LOCATOR_SYMBOL, Locator>)[
						LOCATOR_SYMBOL
					] = selector(root);
				}
			} as unknown as TClass;
		}
		// eslint-disable-next-line @typescript-eslint/restrict-template-expressions
		throw new Error(
			`Decorator SelectorBy... can be used only with class, but used with "${kind}" member of class`,
		);
	};
}

/**
 * Class decorator: sets root locator by test id regex. Use for list containers
 * whose items share a common test id pattern (e.g. `item-1`, `item-2`).
 * Package root classes should extend `RootPageObject`.
 * Plain external classes must receive Playwright `Page` as the first argument.
 *
 * @param id - Regex pattern string for `data-testid`
 *
 * @example
 * ```ts
 * @ListRootSelector("todo-item-")
 * class TodoListRoot extends RootPageObject {}
 * ```
 */
export function ListRootSelector(id: string) {
	return RootSelectorBy((p) => p.getByTestId(new RegExp(id)));
}

/**
 * Class decorator: sets root locator by test id or `body` when omitted.
 * Package root classes should extend `RootPageObject`.
 * Plain external classes must receive Playwright `Page` as the first argument.
 *
 * @param id - Optional `data-testid` value. If omitted, root is `body`.
 *
 * @example
 * ```ts
 * @RootSelector("app-header")
 * class HeaderPageObject extends RootPageObject {}
 * ```
 */
export function RootSelector(id?: string) {
	return RootSelectorBy((p) => (id ? p.getByTestId(id) : p));
}

/**
 * Class decorator: sets root locator by text content.
 * Package root classes should extend `RootPageObject`.
 * Plain external classes must receive Playwright `Page` as the first argument.
 * @param text - Text to match (string or regex)
 */
export function RootSelectorByText(text: string) {
	return RootSelectorBy((p) => p.getByText(text));
}

/**
 * Class decorator: sets root locator by ARIA role.
 * Package root classes should extend `RootPageObject`.
 * Plain external classes must receive Playwright `Page` as the first argument.
 * @param args - Same as {@link Locator.getByRole} (role, options)
 */
export function RootSelectorByRole(...args: Parameters<Locator["getByRole"]>) {
	return RootSelectorBy((p) => p.getByRole(...args));
}

/**
 * Class decorator: sets root locator by associated label.
 * Package root classes should extend `RootPageObject`.
 * Plain external classes must receive Playwright `Page` as the first argument.
 * @param args - Same as {@link Locator.getByLabel}
 */
export function RootSelectorByLabel(
	...args: Parameters<Locator["getByLabel"]>
) {
	return RootSelectorBy((p) => p.getByLabel(...args));
}

/**
 * Class decorator: sets root locator by placeholder text.
 * Package root classes should extend `RootPageObject`.
 * Plain external classes must receive Playwright `Page` as the first argument.
 * @param args - Same as {@link Locator.getByPlaceholder}
 */
export function RootSelectorByPlaceholder(
	...args: Parameters<Locator["getByPlaceholder"]>
) {
	return RootSelectorBy((p) => p.getByPlaceholder(...args));
}

/**
 * Class decorator: sets root locator by alt text (e.g. images).
 * Package root classes should extend `RootPageObject`.
 * Plain external classes must receive Playwright `Page` as the first argument.
 * @param args - Same as {@link Locator.getByAltText}
 */
export function RootSelectorByAltText(
	...args: Parameters<Locator["getByAltText"]>
) {
	return RootSelectorBy((p) => p.getByAltText(...args));
}

/**
 * Class decorator: sets root locator by title attribute.
 * Package root classes should extend `RootPageObject`.
 * Plain external classes must receive Playwright `Page` as the first argument.
 * @param args - Same as {@link Locator.getByTitle}
 */
export function RootSelectorByTitle(
	...args: Parameters<Locator["getByTitle"]>
) {
	return RootSelectorBy((p) => p.getByTitle(...args));
}
