import type { Locator } from "@playwright/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ListPageObject } from "../../page-objects/ListPageObject";
import { PageObject, type SelectorType } from "../../page-objects/PageObject";
import { createMockLocator, createMockPage } from "../mocks/playwright";

describe("ListPageObject", () => {
	let mockPage: ReturnType<typeof createMockPage>;
	let mockRoot: ReturnType<typeof createMockLocator>;
	let mockLocator: ReturnType<typeof createMockLocator>;
	let selector: SelectorType;

	beforeEach(() => {
		mockPage = createMockPage();
		mockRoot = createMockLocator(mockPage);
		mockLocator = createMockLocator(mockPage);
		mockRoot.page = vi.fn().mockReturnValue(mockPage);
		mockLocator.page = vi.fn().mockReturnValue(mockPage);
		selector = vi.fn().mockReturnValue(mockLocator);
	});

	function createList<TItem extends PageObject = PageObject>(
		itemType?: TItem | (new (root?: Locator, selector?: SelectorType) => TItem),
		root: Locator = mockRoot as unknown as Locator,
		listSelector: SelectorType = selector,
	) {
		return new ListPageObject(itemType, root, listSelector);
	}

	describe("at()", () => {
		it("at(n) delegates to getItemByIndex(n)", () => {
			const list = createList();
			void list.at(2).$;
			expect(mockLocator.nth).toHaveBeenCalledWith(2);
		});

		it("at(-1) delegates to getItemByIndex(-1)", () => {
			const list = createList();
			void list.at(-1).$;
			expect(mockLocator.nth).toHaveBeenCalledWith(-1);
		});

		it("at(-2) uses p.nth(-2)", () => {
			const list = createList();
			void list.at(-2).$;
			expect(mockLocator.nth).toHaveBeenCalledWith(-2);
		});

		it("first() same as at(0)", () => {
			const list = createList();
			void list.first().$;
			expect(mockLocator.nth).toHaveBeenCalledWith(0);
		});

		it("last() same as at(-1)", () => {
			const list = createList();
			void list.last().$;
			expect(mockLocator.nth).toHaveBeenCalledWith(-1);
		});

		it("second() same as at(1)", () => {
			const list = createList();
			void list.second().$;
			expect(mockLocator.nth).toHaveBeenCalledWith(1);
		});

		it("items.at(-1) returns same as getItemByIndex(-1)", () => {
			class Item extends PageObject {}
			const list = createList(Item);

			const viaAt = list.items.at(-1);
			const viaGetItem = list.getItemByIndex(-1);

			expect(viaAt).toBeInstanceOf(Item);
			expect(viaGetItem).toBeInstanceOf(Item);
			expect(viaAt.root).toBe(viaGetItem.root);
		});

		it("items.at(0) returns same as first()", () => {
			class Item extends PageObject {}
			const list = createList(Item);

			const viaAt = list.items.at(0);
			const viaFirst = list.first();

			expect(viaAt).toBeInstanceOf(Item);
			expect(viaFirst).toBeInstanceOf(Item);
			expect(viaAt.root).toBe(viaFirst.root);
		});

		it("items.at(-2) uses p.nth(-2)", () => {
			const list = createList();
			void list.items.at(-2).$;
			expect(mockLocator.nth).toHaveBeenCalledWith(-2);
		});
	});

	describe("items proxy", () => {
		it("items[0] returns same as getItemByIndex(0)", () => {
			class Item extends PageObject {}
			const list = createList(Item);

			const viaIndex = list.getItemByIndex(0);
			const viaProxy = list.items[0];

			expect(viaProxy).toBeInstanceOf(Item);
			expect(viaIndex).toBeInstanceOf(Item);
			expect(viaProxy.root).toBe(viaIndex.root);
		});

		it("items[Symbol.asyncIterator] returns async generator", async () => {
			mockLocator.count = vi.fn().mockResolvedValue(2);
			class Item extends PageObject {}
			const list = createList(Item);

			const items: PageObject[] = [];
			for await (const item of list.items) {
				items.push(item);
			}

			expect(items).toHaveLength(2);
		});

		it("items[Symbol.asyncIterator] yields PageObject when no itemType", async () => {
			mockLocator.count = vi.fn().mockResolvedValue(2);
			const list = createList();

			const items: PageObject[] = [];
			for await (const item of list.items) {
				items.push(item);
			}

			expect(items).toHaveLength(2);
			expect(items[0]).toBeInstanceOf(PageObject);
			expect(items[1]).toBeInstanceOf(PageObject);
		});

		it("filtered list async iteration yields items from the narrowed list", async () => {
			const filteredLocator = createMockLocator(mockPage);
			mockLocator.filter = vi.fn().mockReturnValue(filteredLocator);
			filteredLocator.count = vi.fn().mockResolvedValue(2);
			class Item extends PageObject {}
			const list = createList(Item);

			const items: PageObject[] = [];
			for await (const item of list.filterByText("Widget").items) {
				items.push(item);
			}

			expect(items).toHaveLength(2);
			expect(items[0]).toBeInstanceOf(Item);
			expect(items[1]).toBeInstanceOf(Item);
			expect(items[0].root).toBe(filteredLocator);
			expect(items[1].root).toBe(filteredLocator);
		});

		it("items[Symbol.iterator] throws", () => {
			const list = createList();

			expect(() => {
				for (const _ of list.items as unknown as Iterable<unknown>) {
					// noop
				}
			}).toThrow(/not synchronously iterable.*for await/);
		});

		it("items['foo'] falls through to Reflect.get", () => {
			const list = createList();
			expect(
				(list.items as unknown as Record<string, unknown>).foo,
			).toBeUndefined();
		});
	});

	describe("async methods", () => {
		it("count() returns locator.count()", async () => {
			mockLocator.count = vi.fn().mockResolvedValue(5);
			const list = createList();

			const result = await list.count();

			expect(result).toBe(5);
			expect(mockLocator.count).toHaveBeenCalled();
		});

		it("getAll() returns array of getItemByIndex(0..count-1)", async () => {
			mockLocator.count = vi.fn().mockResolvedValue(3);
			class Item extends PageObject {}
			const list = createList(Item);

			const items = await list.getAll();

			expect(items).toHaveLength(3);
			expect(items[0]).toBeInstanceOf(Item);
			expect(items[1]).toBeInstanceOf(Item);
			expect(items[2]).toBeInstanceOf(Item);
		});

		it("getAll() returns array of PageObject instances when no itemType", async () => {
			mockLocator.count = vi.fn().mockResolvedValue(2);
			const list = createList();

			const items = await list.getAll();

			expect(items).toHaveLength(2);
			expect(items[0]).toBeInstanceOf(PageObject);
			expect(items[1]).toBeInstanceOf(PageObject);
		});

		it("getAll() on a filtered list returns items from the narrowed list", async () => {
			const filteredLocator = createMockLocator(mockPage);
			mockLocator.filter = vi.fn().mockReturnValue(filteredLocator);
			filteredLocator.count = vi.fn().mockResolvedValue(2);
			class Item extends PageObject {}
			const list = createList(Item);

			const items = await list.filterByText("Widget").getAll();

			expect(items).toHaveLength(2);
			expect(items[0]).toBeInstanceOf(Item);
			expect(items[1]).toBeInstanceOf(Item);
			expect(items[0].root).toBe(filteredLocator);
			expect(items[1].root).toBe(filteredLocator);
		});

		it("filterByItemTestId(id) keeps ListPageObject APIs on the narrowed list", async () => {
			const pageTestIdLocator = createMockLocator(mockPage);
			const filteredLocator = createMockLocator(mockPage);
			mockPage.getByTestId = vi.fn().mockReturnValue(pageTestIdLocator);
			mockLocator.and = vi.fn().mockReturnValue(filteredLocator);
			filteredLocator.count = vi.fn().mockResolvedValue(2);
			class Item extends PageObject {}
			const list = createList(Item);

			const filtered = list.filterByItemTestId("CartItem_2");
			const first = filtered.first();
			const count = await filtered.count();
			const items = await filtered.getAll();

			expect(first).toBeInstanceOf(Item);
			expect(first.root).toBe(filteredLocator);
			expect(count).toBe(2);
			expect(items).toHaveLength(2);
			expect(items[0]).toBeInstanceOf(Item);
			expect(items[1]).toBeInstanceOf(Item);
			expect(items[0].root).toBe(filteredLocator);
			expect(items[1].root).toBe(filteredLocator);
		});
	});
});
