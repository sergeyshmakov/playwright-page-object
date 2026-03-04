import type { Locator, Page } from "@playwright/test";
import type {
	PageObject,
	PageObjectConstructor,
	SelectorType,
} from "../page-objects/PageObject";

type GConstructor<T = {}> = new (...args: any[]) => T;

function RootSelectorBy(selector: SelectorType) {
	return function <TClass extends PageObjectConstructor>(
		target: TClass,
		context: ClassDecoratorContext<TClass>,
	) {
		const { kind } = context;

		if (kind === "class") {
			const Base = target as unknown as GConstructor<PageObject>;
			return class extends Base {
				constructor(...args: any[]) {
					const page = args[0] as Page;
					super(page, page.locator("body"), selector);
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
 *
 * @param id - Regex pattern string for `data-testid`
 *
 * @example
 * ```ts
 * @ListRootSelector("todo-item-")
 * class TodoList extends ListPageObject<TodoItem> {}
 * ```
 */
export function ListRootSelector(id: string) {
	return RootSelectorBy((p) => p.getByTestId(new RegExp(id)));
}

/**
 * Class decorator: sets root locator by test id or `body` when omitted.
 *
 * @param id - Optional `data-testid` value. If omitted, root is `body`.
 *
 * @example
 * ```ts
 * @RootSelector("app-header")
 * class HeaderPageObject extends PageObject {}
 * ```
 */
export function RootSelector(id?: string) {
	return RootSelectorBy((p) => (id ? p.getByTestId(id) : p));
}

/**
 * Class decorator: sets root locator by text content.
 * @param text - Text to match (string or regex)
 */
export function RootSelectorByText(text: string) {
	return RootSelectorBy((p) => p.getByText(text));
}

/**
 * Class decorator: sets root locator by ARIA role.
 * @param args - Same as {@link Locator.getByRole} (role, options)
 */
export function RootSelectorByRole(...args: Parameters<Locator["getByRole"]>) {
	return RootSelectorBy((p) => p.getByRole(...args));
}

/**
 * Class decorator: sets root locator by associated label.
 * @param args - Same as {@link Locator.getByLabel}
 */
export function RootSelectorByLabel(
	...args: Parameters<Locator["getByLabel"]>
) {
	return RootSelectorBy((p) => p.getByLabel(...args));
}

/**
 * Class decorator: sets root locator by placeholder text.
 * @param args - Same as {@link Locator.getByPlaceholder}
 */
export function RootSelectorByPlaceholder(
	...args: Parameters<Locator["getByPlaceholder"]>
) {
	return RootSelectorBy((p) => p.getByPlaceholder(...args));
}

/**
 * Class decorator: sets root locator by alt text (e.g. images).
 * @param args - Same as {@link Locator.getByAltText}
 */
export function RootSelectorByAltText(
	...args: Parameters<Locator["getByAltText"]>
) {
	return RootSelectorBy((p) => p.getByAltText(...args));
}

/**
 * Class decorator: sets root locator by title attribute.
 * @param args - Same as {@link Locator.getByTitle}
 */
export function RootSelectorByTitle(
	...args: Parameters<Locator["getByTitle"]>
) {
	return RootSelectorBy((p) => p.getByTitle(...args));
}
