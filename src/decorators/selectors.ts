import type { Locator } from "@playwright/test";
import { PageObject, type SelectorType } from "../page-objects/PageObject";
import { SelectorBy } from "./selectorBy";

const getSelector =
	<TValue extends Locator | PageObject>(selector: SelectorType) =>
	(root: Locator, value: TValue): TValue => {
		if (PageObject.isInstance(value)) {
			return value.cloneWithContext(root, selector) as TValue;
		} else {
			return selector(root) as TValue;
		}
	};

/**
 * Accessor decorator: locator by test id regex. Use for list items sharing a pattern.
 *
 * @param itemMask - Regex pattern string for `data-testid`
 *
 * @example
 * ```ts
 * @ListSelector("todo-item-")
 * accessor item = this.locator;
 * ```
 */
export function ListSelector(itemMask: string) {
	const selector = getSelector((p) => p.getByTestId(new RegExp(itemMask)));
	return SelectorBy(selector);
}

/**
 * Accessor decorator: locator by exact test id.
 * @param itemId - Exact `data-testid` value
 */
export function ListStrictSelector(itemId: string) {
	const selector = getSelector((p) => p.getByTestId(itemId));
	return SelectorBy(selector);
}

/**
 * Accessor decorator: locator by test id or self when omitted.
 * @param id - Optional `data-testid` value. If omitted, returns root locator.
 */
export function Selector(id?: string) {
	const selector = getSelector((p) => (id ? p.getByTestId(id) : p));
	return SelectorBy(selector);
}

/**
 * Accessor decorator: locator by ARIA role.
 * @param args - Same as {@link Locator.getByRole} (role, options)
 */
export function SelectorByRole(...args: Parameters<Locator["getByRole"]>) {
	const selector = getSelector((p) => (args ? p.getByRole(...args) : p));
	return SelectorBy(selector);
}

/**
 * Accessor decorator: locator by text content.
 * @param text - Text to match (string or regex)
 */
export function SelectorByText(text: string) {
	const selector = getSelector((p) => p.getByText(text));
	return SelectorBy(selector);
}

/**
 * Accessor decorator: locator by associated label.
 * @param args - Same as {@link Locator.getByLabel}
 */
export function SelectorByLabel(...args: Parameters<Locator["getByLabel"]>) {
	const selector = getSelector((p) => (args ? p.getByLabel(...args) : p));
	return SelectorBy(selector);
}

/**
 * Accessor decorator: locator by placeholder text.
 * @param args - Same as {@link Locator.getByPlaceholder}
 */
export function SelectorByPlaceholder(
	...args: Parameters<Locator["getByPlaceholder"]>
) {
	const selector = getSelector((p) => (args ? p.getByPlaceholder(...args) : p));
	return SelectorBy(selector);
}

/**
 * Accessor decorator: locator by alt text (e.g. images).
 * @param args - Same as {@link Locator.getByAltText}
 */
export function SelectorByAltText(
	...args: Parameters<Locator["getByAltText"]>
) {
	const selector = getSelector((p) => (args ? p.getByAltText(...args) : p));
	return SelectorBy(selector);
}

/**
 * Accessor decorator: locator by title attribute.
 * @param args - Same as {@link Locator.getByTitle}
 */
export function SelectorByTitle(...args: Parameters<Locator["getByTitle"]>) {
	const selector = getSelector((p) => (args ? p.getByTitle(...args) : p));
	return SelectorBy(selector);
}
