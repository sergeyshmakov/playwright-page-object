import type { Locator, Page } from "@playwright/test";
import { PageObject, type SelectorType } from "./PageObject";

/**
 * Page object for a list of items, each represented by a `TItem` page object.
 *
 * Use with `ListRootSelector` and `ListSelector` (or `ListStrictSelector`) to define
 * the list container and item pattern. Supports filtering, indexing, and async iteration.
 *
 * @typeParam TItem - PageObject type for each list item (default: `PageObject`)
 *
 * @example
 * ```ts
 * @ListRootSelector("todo-list")
 * class TodoList extends ListPageObject<TodoItem> {
 *   constructor() {
 *     super(TodoItem);
 *   }
 * }
 * ```
 */
export class ListPageObject<
	TItem extends PageObject = PageObject,
> extends PageObject {
	protected itemType?:
		| TItem
		| (new (
				page?: Page,
				root?: Locator,
				selector?: SelectorType,
		  ) => TItem);

	/**
	 * @param itemType - PageObject class or instance for each list item.
	 *   - **Class**: Use when items use the default constructor.
	 *   - **Instance**: Use when items need a custom constructor with specific arguments.
	 * @param page - Playwright page (optional when nested)
	 * @param root - Root locator (set by decorators)
	 * @param selector - Selector function (set by decorators)
	 */
	constructor(
		itemType?:
			| TItem
			| (new (
					page?: Page,
					root?: Locator,
					selector?: SelectorType,
			  ) => TItem),
		page?: Page,
		root?: Locator,
		selector?: SelectorType,
	) {
		super(page, root, selector);
		this.itemType = itemType;
	}

	override cloneWithContext(root: Locator, selector: SelectorType): this {
		const ListPageObjectClass = this.constructor as new (
			itemType?:
				| TItem
				| (new (
						page?: Page,
						root?: Locator,
						selector?: SelectorType,
				  ) => TItem),
			page?: Page,
			root?: Locator,
			selector?: SelectorType,
		) => this;

		return new ListPageObjectClass(this.itemType, root.page(), root, selector);
	}

	/**
	 * Returns the item at the given index (0-based). Use `-1` for last item.
	 * @param index - Item index
	 * @returns PageObject for the item at that index
	 */
	getItemByIndex(index: number) {
		return this.resolveItem((p) => p.nth(index));
	}

	/**
	 * Returns the item at the given index. Supports negative indices like Array.at().
	 * @param index - Item index (0-based; -1 = last, -2 = second-to-last, etc.)
	 * @returns PageObject for the item at that index
	 */
	at(index: number) {
		return this.getItemByIndex(index);
	}

	/**
	 * Returns items matching the given Playwright filter options.
	 * @param options - Playwright locator filter (e.g. `{ hasText: 'foo' }`)
	 * @returns PageObject for the filtered item(s)
	 */
	filter(options: Parameters<Locator["filter"]>[0]) {
		return this.resolveItem((p) => p.filter(options));
	}

	/**
	 * Returns items containing the given text.
	 * @param text - Text to match (string or regex)
	 * @returns PageObject for the matching item(s)
	 */
	filterByText(text: string) {
		return this.resolveItem((p) => p.filter({ hasText: text }));
	}

	/**
	 * Returns items that contain an element with the given test id.
	 * Requires `page` to be set.
	 * @param id - Test id (string or regex)
	 * @returns PageObject for the matching item(s)
	 */
	filterByTestId(id: string | RegExp) {
		if (!this.page) {
			throw new Error(
				"[ListPageObject] filterByTestId requires page to be set",
			);
		}
		const page = this.page;
		return this.resolveItem((p) => p.filter({ has: page.getByTestId(id) }));
	}

	/**
	 * Returns the item whose test id matches the given regex pattern.
	 * @param mask - Regex pattern string for test id
	 * @returns PageObject for the matching item
	 */
	getItemByIdMask(mask: string) {
		return this.resolveItem((p) => p.getByTestId(new RegExp(mask)));
	}

	/** Returns the first item (index 0). */
	first() {
		return this.at(0);
	}

	/** Returns the last item (index -1). */
	last() {
		return this.at(-1);
	}

	/**
	 * Returns the item containing the given text.
	 * @param text - Text to match (string or regex)
	 * @returns PageObject for the matching item
	 */
	getItemByText(text: string) {
		return this.resolveItem((p) => p.getByText(text));
	}

	/**
	 * Returns the item matching the given ARIA role and options.
	 * @param args - Same as {@link Locator.getByRole}
	 * @returns PageObject for the matching item
	 */
	getItemByRole(...args: Parameters<Locator["getByRole"]>) {
		return this.resolveItem((p) => p.getByRole(...args));
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
	 * Returns all items as an array of page objects.
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

	protected resolveItem(selector: SelectorType): TItem {
		if (!this.itemType) {
			return new PageObject(this.page, this.locator, selector) as TItem;
		}

		if (PageObject.isInstance(this.itemType)) {
			return this.itemType.cloneWithContext(this.locator, selector) as TItem;
		}

		if (PageObject.isClass(this.itemType)) {
			return new this.itemType(this.page, this.locator, selector);
		}

		return selector(this.locator) as unknown as TItem;
	}
}
