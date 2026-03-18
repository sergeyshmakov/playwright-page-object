import type { Locator } from "@playwright/test";
import { PageObject, type SelectorType } from "../page-objects/PageObject";
import { SelectorBy } from "./selectorBy";

type LocatorFactoryArg<T> =
	| ((locator: Locator) => T)
	| (new (
			locator: Locator,
			...args: never[]
	  ) => T);

function isLocatorFactoryArg(
	value: unknown,
): value is LocatorFactoryArg<unknown> {
	return typeof value === "function";
}

function toLocatorFactory<T>(
	value?: LocatorFactoryArg<T>,
): ((locator: Locator) => T) | undefined {
	if (!value) {
		return undefined;
	}

	return value.prototype !== undefined
		? (locator: Locator) =>
				new (value as new (locator: Locator, ...args: never[]) => T)(locator)
		: (value as (locator: Locator) => T);
}

const getSelector =
	<TValue>(
		selector: SelectorType,
		locatorFactory?: (locator: Locator) => TValue,
	) =>
	(root: Locator, value: TValue): TValue => {
		if (PageObject.isInstance(value)) {
			return value.cloneWithContext(root, selector) as TValue;
		}

		const resolvedLocator = selector(root);

		if (locatorFactory) {
			return locatorFactory(resolvedLocator);
		}

		return resolvedLocator as TValue;
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
export function ListSelector(itemMask: string): ReturnType<typeof SelectorBy>;
export function ListSelector<T>(
	itemMask: string,
	locatorFactory: LocatorFactoryArg<T>,
): ReturnType<typeof SelectorBy>;
export function ListSelector<T>(
	itemMask: string,
	locatorFactory?: LocatorFactoryArg<T>,
) {
	const selector = getSelector(
		(p) => p.getByTestId(new RegExp(itemMask)),
		toLocatorFactory(locatorFactory),
	);
	return SelectorBy(selector);
}

/**
 * Accessor decorator: locator by exact test id.
 * @param itemId - Exact `data-testid` value
 */
export function ListStrictSelector(
	itemId: string,
): ReturnType<typeof SelectorBy>;
export function ListStrictSelector<T>(
	itemId: string,
	locatorFactory: LocatorFactoryArg<T>,
): ReturnType<typeof SelectorBy>;
export function ListStrictSelector<T>(
	itemId: string,
	locatorFactory?: LocatorFactoryArg<T>,
) {
	const selector = getSelector(
		(p) => p.getByTestId(itemId),
		toLocatorFactory(locatorFactory),
	);
	return SelectorBy(selector);
}

/**
 * Accessor decorator: locator by test id or self when omitted.
 * @param id - Optional `data-testid` value. If omitted, returns root locator.
 */
export function Selector(id?: string): ReturnType<typeof SelectorBy>;
export function Selector<T>(
	id: string,
	locatorFactory: LocatorFactoryArg<T>,
): ReturnType<typeof SelectorBy>;
export function Selector<T>(
	id?: string,
	locatorFactory?: LocatorFactoryArg<T>,
) {
	const selector = getSelector(
		(p) => (id ? p.getByTestId(id) : p),
		toLocatorFactory(locatorFactory),
	);
	return SelectorBy(selector);
}

/**
 * Accessor decorator: locator by ARIA role.
 * @param args - Same as {@link Locator.getByRole} (role, options)
 */
export function SelectorByRole(
	...args: Parameters<Locator["getByRole"]>
): ReturnType<typeof SelectorBy>;
export function SelectorByRole<T>(
	...args: [...Parameters<Locator["getByRole"]>, LocatorFactoryArg<T>]
): ReturnType<typeof SelectorBy>;
export function SelectorByRole<T>(
	...args:
		| Parameters<Locator["getByRole"]>
		| [...Parameters<Locator["getByRole"]>, LocatorFactoryArg<T>]
) {
	const lastArg = args[args.length - 1];
	const locatorFactory = isLocatorFactoryArg(lastArg)
		? toLocatorFactory(lastArg)
		: undefined;
	const roleArgs = (locatorFactory ? args.slice(0, -1) : args) as Parameters<
		Locator["getByRole"]
	>;
	const selector = getSelector((p) => p.getByRole(...roleArgs), locatorFactory);
	return SelectorBy(selector);
}

/**
 * Accessor decorator: locator by text content.
 * @param text - Text to match (string or regex)
 */
export function SelectorByText(text: string): ReturnType<typeof SelectorBy>;
export function SelectorByText<T>(
	text: string,
	locatorFactory: LocatorFactoryArg<T>,
): ReturnType<typeof SelectorBy>;
export function SelectorByText<T>(
	text: string,
	locatorFactory?: LocatorFactoryArg<T>,
) {
	const selector = getSelector(
		(p) => p.getByText(text),
		toLocatorFactory(locatorFactory),
	);
	return SelectorBy(selector);
}

/**
 * Accessor decorator: locator by associated label.
 * @param args - Same as {@link Locator.getByLabel}
 */
export function SelectorByLabel(
	...args: Parameters<Locator["getByLabel"]>
): ReturnType<typeof SelectorBy>;
export function SelectorByLabel<T>(
	...args: [...Parameters<Locator["getByLabel"]>, LocatorFactoryArg<T>]
): ReturnType<typeof SelectorBy>;
export function SelectorByLabel<T>(
	...args:
		| Parameters<Locator["getByLabel"]>
		| [...Parameters<Locator["getByLabel"]>, LocatorFactoryArg<T>]
) {
	const lastArg = args[args.length - 1];
	const locatorFactory = isLocatorFactoryArg(lastArg)
		? toLocatorFactory(lastArg)
		: undefined;
	const labelArgs = (locatorFactory ? args.slice(0, -1) : args) as Parameters<
		Locator["getByLabel"]
	>;
	const selector = getSelector(
		(p) => p.getByLabel(...labelArgs),
		locatorFactory,
	);
	return SelectorBy(selector);
}

/**
 * Accessor decorator: locator by placeholder text.
 * @param args - Same as {@link Locator.getByPlaceholder}
 */
export function SelectorByPlaceholder(
	...args: Parameters<Locator["getByPlaceholder"]>
): ReturnType<typeof SelectorBy>;
export function SelectorByPlaceholder<T>(
	...args: [...Parameters<Locator["getByPlaceholder"]>, LocatorFactoryArg<T>]
): ReturnType<typeof SelectorBy>;
export function SelectorByPlaceholder<T>(
	...args:
		| Parameters<Locator["getByPlaceholder"]>
		| [...Parameters<Locator["getByPlaceholder"]>, LocatorFactoryArg<T>]
) {
	const lastArg = args[args.length - 1];
	const locatorFactory = isLocatorFactoryArg(lastArg)
		? toLocatorFactory(lastArg)
		: undefined;
	const placeholderArgs = (
		locatorFactory ? args.slice(0, -1) : args
	) as Parameters<Locator["getByPlaceholder"]>;
	const selector = getSelector(
		(p) => p.getByPlaceholder(...placeholderArgs),
		locatorFactory,
	);
	return SelectorBy(selector);
}

/**
 * Accessor decorator: locator by alt text (e.g. images).
 * @param args - Same as {@link Locator.getByAltText}
 */
export function SelectorByAltText(
	...args: Parameters<Locator["getByAltText"]>
): ReturnType<typeof SelectorBy>;
export function SelectorByAltText<T>(
	...args: [...Parameters<Locator["getByAltText"]>, LocatorFactoryArg<T>]
): ReturnType<typeof SelectorBy>;
export function SelectorByAltText<T>(
	...args:
		| Parameters<Locator["getByAltText"]>
		| [...Parameters<Locator["getByAltText"]>, LocatorFactoryArg<T>]
) {
	const lastArg = args[args.length - 1];
	const locatorFactory = isLocatorFactoryArg(lastArg)
		? toLocatorFactory(lastArg)
		: undefined;
	const altTextArgs = (locatorFactory ? args.slice(0, -1) : args) as Parameters<
		Locator["getByAltText"]
	>;
	const selector = getSelector(
		(p) => p.getByAltText(...altTextArgs),
		locatorFactory,
	);
	return SelectorBy(selector);
}

/**
 * Accessor decorator: locator by title attribute.
 * @param args - Same as {@link Locator.getByTitle}
 */
export function SelectorByTitle(
	...args: Parameters<Locator["getByTitle"]>
): ReturnType<typeof SelectorBy>;
export function SelectorByTitle<T>(
	...args: [...Parameters<Locator["getByTitle"]>, LocatorFactoryArg<T>]
): ReturnType<typeof SelectorBy>;
export function SelectorByTitle<T>(
	...args:
		| Parameters<Locator["getByTitle"]>
		| [...Parameters<Locator["getByTitle"]>, LocatorFactoryArg<T>]
) {
	const lastArg = args[args.length - 1];
	const locatorFactory = isLocatorFactoryArg(lastArg)
		? toLocatorFactory(lastArg)
		: undefined;
	const titleArgs = (locatorFactory ? args.slice(0, -1) : args) as Parameters<
		Locator["getByTitle"]
	>;
	const selector = getSelector(
		(p) => p.getByTitle(...titleArgs),
		locatorFactory,
	);
	return SelectorBy(selector);
}
