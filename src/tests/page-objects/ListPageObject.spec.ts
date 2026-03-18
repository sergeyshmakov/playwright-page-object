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

	describe("constructor and cloneWithContext", () => {
		it("stores itemType", () => {
			class Item extends PageObject {}
			const list = createList(Item);
			expect((list as unknown as { itemType: unknown }).itemType).toBe(Item);
		});

		it("cloneWithContext preserves itemType and passes root, selector", () => {
			class Item extends PageObject {}
			const list = createList(Item);
			const newRoot = createMockLocator(mockPage);
			newRoot.page = vi.fn().mockReturnValue(mockPage);
			const newSelector = vi.fn().mockReturnValue(createMockLocator());

			const cloned = list.cloneWithContext(
				newRoot as unknown as Locator,
				newSelector as unknown as SelectorType,
			);

			expect((cloned as unknown as { itemType: unknown }).itemType).toBe(Item);
			expect(cloned.page).toBe(mockPage);
			expect(cloned.root).toBe(newRoot);
		});
	});

	describe("resolveItem (via public methods)", () => {
		it("no itemType returns PageObject instance", () => {
			const itemLocator = createMockLocator();
			mockLocator.nth = vi.fn().mockReturnValue(itemLocator);
			const list = createList();

			const result = list.getItemByIndex(0);

			expect(result).toBeInstanceOf(PageObject);
			expect(result.page).toBe(mockPage);
			expect(result.root).toBe(mockLocator);
			void result.$; // trigger lazy locator resolution
			expect(mockLocator.nth).toHaveBeenCalledWith(0);
		});

		it("itemType is instance calls cloneWithContext", () => {
			class Item extends PageObject {}
			const itemInstance = new Item(
				mockRoot as unknown as Locator,
				vi.fn() as unknown as SelectorType,
			);
			const cloneSpy = vi.spyOn(itemInstance, "cloneWithContext");

			const list = createList(itemInstance);
			list.getItemByIndex(0);

			expect(cloneSpy).toHaveBeenCalledWith(mockLocator, expect.any(Function));
		});

		it("itemType is class creates new instance", () => {
			class Item extends PageObject {}
			const list = createList(Item);

			const result = list.getItemByIndex(0);

			expect(result).toBeInstanceOf(Item);
			expect(result.page).toBe(mockPage);
			expect(result.root).toBe(mockLocator);
		});

		it("filterByText returns a narrowed list and preserves itemType", () => {
			class Item extends PageObject {}
			const filteredLocator = createMockLocator(mockPage);
			mockLocator.filter = vi.fn().mockReturnValue(filteredLocator);
			const list = createList(Item);

			const result = list.filterByText("bar");

			expect(result).toBeInstanceOf(ListPageObject);
			expect((result as unknown as { itemType: unknown }).itemType).toBe(Item);
			expect(result.page).toBe(mockPage);
			expect(result.root).toBe(mockLocator);
			expect(result.$).toBe(filteredLocator);
			expect(mockLocator.filter).toHaveBeenCalledWith({ hasText: "bar" });
		});

		it("no itemType: items[0] and items.at(0) return PageObject", () => {
			const list = createList();

			const viaIndex = list.items[0];
			const viaAt = list.items.at(0);

			expect(viaIndex).toBeInstanceOf(PageObject);
			expect(viaAt).toBeInstanceOf(PageObject);
			expect(viaIndex.page).toBe(mockPage);
			expect(viaAt.root).toBe(mockLocator);
		});

		it("no itemType: cloneWithContext yields PageObject items", () => {
			const newListLocator = createMockLocator(mockPage);
			const list = createList();
			const newRoot = createMockLocator(mockPage);
			newRoot.page = vi.fn().mockReturnValue(mockPage);
			const newSelector = vi.fn().mockReturnValue(newListLocator);

			const cloned = list.cloneWithContext(
				newRoot as unknown as Locator,
				newSelector as unknown as SelectorType,
			);
			const result = cloned.getItemByIndex(0);

			expect(result).toBeInstanceOf(PageObject);
			expect(result.page).toBe(mockPage);
			expect(result.root).toBe(newListLocator);
		});

		it("no itemType: item supports PageObject API (expect, $)", () => {
			const itemLocator = createMockLocator();
			mockLocator.nth = vi.fn().mockReturnValue(itemLocator);
			const list = createList();
			const item = list.getItemByIndex(0);

			expect(typeof item.expect).toBe("function");
			expect(item.$).toBeDefined();
			expect(item.$).toBe(itemLocator);
		});
	});

	describe("item resolution methods", () => {
		it("getItemByIndex(n) uses p => p.nth(n)", () => {
			const list = createList();
			void list.getItemByIndex(3).$;
			expect(mockLocator.nth).toHaveBeenCalledWith(3);
		});

		it("getItemByIndex(-1) uses p => p.nth(-1)", () => {
			const list = createList();
			void list.getItemByIndex(-1).$;
			expect(mockLocator.nth).toHaveBeenCalledWith(-1);
		});

		it("first() same as getItemByIndex(0)", () => {
			const list = createList();
			void list.first().$;
			expect(mockLocator.nth).toHaveBeenCalledWith(0);
		});

		it("last() same as getItemByIndex(-1)", () => {
			const list = createList();
			void list.last().$;
			expect(mockLocator.nth).toHaveBeenCalledWith(-1);
		});

		it("filter(options) returns a narrowed list", () => {
			const filteredLocator = createMockLocator(mockPage);
			mockLocator.filter = vi.fn().mockReturnValue(filteredLocator);
			const list = createList();

			const result = list.filter({ hasText: "foo" });

			expect(result).toBeInstanceOf(ListPageObject);
			expect(result.$).toBe(filteredLocator);
			expect(mockLocator.filter).toHaveBeenCalledWith({ hasText: "foo" });
		});

		it("filterByText(text) returns a narrowed list", () => {
			const filteredLocator = createMockLocator(mockPage);
			mockLocator.filter = vi.fn().mockReturnValue(filteredLocator);
			const list = createList();

			const result = list.filterByText("bar");

			expect(result).toBeInstanceOf(ListPageObject);
			expect(result.$).toBe(filteredLocator);
			expect(mockLocator.filter).toHaveBeenCalledWith({ hasText: "bar" });
		});

		it("filterByTestId(id) returns a narrowed list", () => {
			const filteredLocator = createMockLocator(mockPage);
			mockLocator.filter = vi.fn().mockReturnValue(filteredLocator);
			const list = createList();

			const result = list.filterByTestId("myId");

			expect(result).toBeInstanceOf(ListPageObject);
			expect(result.$).toBe(filteredLocator);
			expect(mockLocator.filter).toHaveBeenCalledWith({
				has: expect.anything(),
			});
			expect(mockPage.getByTestId).toHaveBeenCalledWith("myId");
		});

		it("getItemByIdMask(mask) returns the first matched item from the filtered list", () => {
			const filteredLocator = createMockLocator(mockPage);
			mockLocator.filter = vi.fn().mockReturnValue(filteredLocator);
			const list = createList();
			void list.getItemByIdMask("Item-").$;
			expect(mockPage.getByTestId).toHaveBeenCalledWith(expect.any(RegExp));
			expect(mockLocator.filter).toHaveBeenCalledWith({
				has: expect.anything(),
			});
			expect(filteredLocator.nth).toHaveBeenCalledWith(0);
		});

		it("getItemByText(text) returns the first matched item from the filtered list", () => {
			const filteredLocator = createMockLocator(mockPage);
			mockLocator.filter = vi.fn().mockReturnValue(filteredLocator);
			const list = createList();
			void list.getItemByText("hello").$;
			expect(mockLocator.filter).toHaveBeenCalledWith({ hasText: "hello" });
			expect(filteredLocator.nth).toHaveBeenCalledWith(0);
		});

		it("getItemByRole(...args) returns the first matched item from the filtered list", () => {
			const filteredLocator = createMockLocator(mockPage);
			mockLocator.filter = vi.fn().mockReturnValue(filteredLocator);
			const list = createList();
			void list.getItemByRole("button", { name: "Submit" }).$;
			expect(mockLocator.getByRole).toHaveBeenCalledWith("button", {
				name: "Submit",
			});
			expect(mockLocator.filter).toHaveBeenCalledWith({
				has: expect.anything(),
			});
			expect(filteredLocator.nth).toHaveBeenCalledWith(0);
		});

		it("second() returns item at index 1", () => {
			const list = createList();
			void list.second().$;
			expect(mockLocator.nth).toHaveBeenCalledWith(1);
		});
	});

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
	});
});
