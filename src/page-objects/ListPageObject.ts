import type { Locator } from "@playwright/test";
import { PageObject, type SelectorType } from "./PageObject";

/**
 * Page object for a list of items, each represented by a `TItem` page object.
 *
 * Use as a nested list control together with `Selector` or `ListSelector`.
 * Supports filtering, indexing, and async iteration.
 *
 * @typeParam TItem - PageObject type for each list item (default: `PageObject`)
 *
 * @example
 * ```ts
 * class TodoPage extends RootPageObject {
 *   @Selector("TodoList")
 *   accessor items = new ListPageObject(TodoItem);
 * }
 * ```
 */
export class ListPageObject<
	TItem extends PageObject = PageObject,
> extends PageObject {
	protected itemType?:
		| TItem
		| (new (
				root?: Locator,
				selector?: SelectorType,
		  ) => TItem);

	/**
	 * @param itemType - PageObject class or instance for each list item.
	 *   - **Class**: Use when items use the default constructor `(root?, selector?)`.
	 *   - **Instance**: Use when items need a custom constructor — pass a pre-configured
	 *     instance and it will be cloned via `cloneWithContext()` for each item.
	 * @param root - Root locator (set by decorators)
	 * @param selector - Selector function (set by decorators)
	 * @throws If `itemType` is provided but is neither a `PageObject` subclass nor a
	 *   `PageObject` instance. Pass a class (`new ListPageObject(MyItem)`) or an
	 *   instance (`new ListPageObject(new MyItem())`).
	 */
	constructor(
		itemType?: TItem | (new (root?: Locator, selector?: SelectorType) => TItem),
		root?: Locator,
		selector?: SelectorType,
	) {
		super(root, selector);

		if (
			itemType !== undefined &&
			!PageObject.isInstance(itemType) &&
			!PageObject.isClass(itemType)
		) {
			throw new Error(
				`[ListPageObject] itemType must be a PageObject subclass constructor or instance, got ${typeof itemType}. ` +
					"Pass a class: new ListPageObject(MyItemControl), or an instance: new ListPageObject(new MyItemControl()).",
			);
		}

		this.itemType = itemType;
	}

	override cloneWithContext(root: Locator, selector: SelectorType): this {
		const ListPageObjectClass = this.constructor as new (
			itemType?:
				| TItem
				| (new (
						root?: Locator,
						selector?: SelectorType,
				  ) => TItem),
			root?: Locator,
			selector?: SelectorType,
		) => this;

		return new ListPageObjectClass(this.itemType, root, selector);
	}

	/**
	 * Returns the item at the given index (0-based). Supports negative indices like
	 * `Array.at()` — use `-1` for last, `-2` for second-to-last, etc.
	 * @param index - Item index
	 * @returns PageObject for the item at that index
	 */
	getItemByIndex(index: number): TItem {
		return this.resolveItem((p) => p.nth(index));
	}

	/**
	 * Returns the item at the given index. Alias for `getItemByIndex` with negative
	 * index support matching `Array.at()` semantics.
	 * @param index - Item index (0-based; -1 = last, -2 = second-to-last, etc.)
	 * @returns PageObject for the item at that index
	 */
	at(index: number): TItem {
		return this.getItemByIndex(index);
	}

	/**
	 * Returns a narrowed list matching the given Playwright filter options.
	 * @param options - Playwright locator filter (e.g. `{ hasText: 'foo' }`)
	 * @returns Narrowed list page object containing the filtered item(s)
	 */
	filter(options: Parameters<Locator["filter"]>[0]): this {
		return this.resolveList((p) => p.filter(options));
	}

	/**
	 * Returns a narrowed list of items containing the given text.
	 * @param text - Text to match (string or regex)
	 * @returns Narrowed list page object containing the matching item(s)
	 */
	filterByText(text: string | RegExp): this {
		return this.filter({ hasText: text });
	}

	/**
	 * Returns a narrowed list of items whose **own** `data-testid` matches the given
	 * value. Use this when the item row itself carries the test id.
	 *
	 * For rows that *contain* a descendant with the test id, use `filterByHasTestId`.
	 *
	 * @param id - Test id (string or regex)
	 * @returns Narrowed list page object containing the matching item(s)
	 */
	filterByItemTestId(id: string | RegExp): this {
		return this.resolveList((p) => p.and(this.page.getByTestId(id)));
	}

	/**
	 * Returns a narrowed list of items that contain a **descendant** with the given
	 * test id (Playwright `has` filter). Use this when matching by a child element's
	 * test id, not the row's own test id.
	 *
	 * For rows whose own test id matches, use `filterByItemTestId`.
	 *
	 * @param id - Test id (string or regex)
	 * @returns Narrowed list page object containing the matching item(s)
	 */
	filterByHasTestId(id: string | RegExp): this {
		return this.resolveList((p) =>
			p.filter({ has: this.page.getByTestId(id) }),
		);
	}

	/**
	 * Returns the item whose own `data-testid` matches the given value.
	 * @param id - Test id (string or regex)
	 * @returns PageObject for the matching item
	 */
	getItemByTestId(id: string | RegExp): TItem {
		return this.filterByItemTestId(id).first();
	}

	/** Returns the first item (index 0). */
	first(): TItem {
		return this.at(0);
	}

	/** Returns the second item (index 1). */
	second(): TItem {
		return this.at(1);
	}

	/** Returns the last item (index -1). */
	last(): TItem {
		return this.at(-1);
	}

	/**
	 * Returns the item containing the given text.
	 * @param text - Text to match (string or regex)
	 * @returns PageObject for the matching item
	 */
	getItemByText(text: string | RegExp): TItem {
		return this.filterByText(text).first();
	}

	/**
	 * Returns the first item containing an element matching the given ARIA role and options.
	 * @param args - Same as {@link Locator.getByRole}
	 * @returns PageObject for the matching item
	 */
	getItemByRole(...args: Parameters<Locator["getByRole"]>): TItem {
		return this.resolveList((p) =>
			p.filter({ has: p.getByRole(...args) }),
		).first();
	}

	/**
	 * Proxy for indexed access and async iteration.
	 *
	 * - **Numeric index**: `list.items[0]` returns the item at index 0
	 * - **at(index)**: `list.items.at(-1)` returns the last item (supports negative indices)
	 * - **Async iteration**: `for await (const item of list.items)` yields each item
	 *
	 * Use `for await...of` or `await list.getAll()` — not synchronous `for...of`.
	 */
	get items(): Record<number, TItem> &
		AsyncIterable<TItem> & {
			at(index: number): TItem;
		} {
		const self = this;

		const proxy = new Proxy(
			{} as Record<number, TItem> & AsyncIterable<TItem>,
			{
				get: (target, prop) => {
					if (prop === "at") {
						return (index: number) => self.getItemByIndex(index);
					}
					if (prop === Symbol.asyncIterator) {
						return async function* () {
							const count = await self.count();
							for (let i = 0; i < count; i++) {
								yield self.getItemByIndex(i);
							}
						};
					}
					if (prop === Symbol.iterator) {
						throw new Error(
							"list.items is not synchronously iterable. Use `for await...of` or `await list.getAll()`.",
						);
					}
					if (typeof prop === "string" || typeof prop === "number") {
						const index = Number(prop);
						if (!Number.isNaN(index)) {
							return self.getItemByIndex(index);
						}
					}
					return Reflect.get(target, prop);
				},
			},
		);
		return proxy as Record<number, TItem> &
			AsyncIterable<TItem> & {
				at(index: number): TItem;
			};
	}

	/**
	 * Returns the number of items in the list.
	 * @returns Count of matching elements
	 */
	async count(): Promise<number> {
		return await this.locator.count();
	}

	/**
	 * Returns all items as an array of page objects. Each item is a lazy locator
	 * wrapper — the count is resolved eagerly but individual element actions are
	 * deferred until called.
	 * @returns Array of `TItem` instances
	 */
	async getAll(): Promise<TItem[]> {
		const count = await this.count();
		const items: TItem[] = [];
		for (let i = 0; i < count; i++) {
			items.push(this.getItemByIndex(i));
		}
		return items;
	}

	protected resolveList(selector: SelectorType): this {
		return this.cloneWithContext(this.locator, selector);
	}

	protected resolveItem(selector: SelectorType): TItem {
		if (!this.itemType) {
			return new PageObject(this.locator, selector) as TItem;
		}

		if (PageObject.isInstance(this.itemType)) {
			return this.itemType.cloneWithContext(this.locator, selector) as TItem;
		}

		return new this.itemType(this.locator, selector);
	}
}
