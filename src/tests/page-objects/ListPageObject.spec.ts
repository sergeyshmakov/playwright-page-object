import { beforeEach, describe, expect, it, vi } from "vitest";
import { ListPageObject } from "../../page-objects/ListPageObject";
import {
	PageObject,
	type PageObjectConstructor,
	type SelectorType,
} from "../../page-objects/PageObject";
import { createMockLocator, createMockPage } from "../mocks/playwright";

describe("ListPageObject", () => {
	let mockPage: ReturnType<typeof createMockPage>;
	let mockRoot: ReturnType<typeof createMockLocator>;
	let mockLocator: ReturnType<typeof createMockLocator>;
	let selector: SelectorType;

	function createList<TItem extends PageObject = PageObject>(
		itemType?: TItem | PageObjectConstructor<TItem>,
		root: ReturnType<typeof createMockLocator> = mockRoot,
		selectorFn: SelectorType = selector,
	) {
		return new ListPageObject(itemType, mockPage, root, selectorFn);
	}

	function getItemType(list: ListPageObject) {
		return (
			list as unknown as ListPageObject & {
				itemType: unknown;
			}
		).itemType;
	}

	beforeEach(() => {
		mockPage = createMockPage();
		mockRoot = createMockLocator(mockPage);
		mockLocator = createMockLocator(mockPage);
		mockRoot.page = vi.fn().mockReturnValue(mockPage);
		mockLocator.page = vi.fn().mockReturnValue(mockPage);
		selector = vi.fn().mockReturnValue(mockLocator);
	});

	describe("constructor and cloneWithContext", () => {
		it("stores itemType", () => {
			class Item extends PageObject {}
			const list = createList(Item);
			expect(getItemType(list)).toBe(Item);
		});

		it("cloneWithContext preserves itemType and passes root.page(), root, selector", () => {
			class Item extends PageObject {}
			const list = createList(Item);
			const newRoot = createMockLocator(mockPage);
			newRoot.page = vi.fn().mockReturnValue(mockPage);
			const newSelector: SelectorType = vi
				.fn()
				.mockReturnValue(createMockLocator());

			const cloned = list.cloneWithContext(newRoot, newSelector);

			expect(getItemType(cloned)).toBe(Item);
			expect(cloned.page).toBe(mockPage);
			expect(cloned.root).toBe(newRoot);
		});
	});

	describe("resolveItem (via public methods)", () => {
		it("no itemType returns selector(locator) as TItem", () => {
			const itemLocator = createMockLocator();
			mockLocator.nth = vi.fn().mockReturnValue(itemLocator);
			const list = createList();

			const result = list.getItemByIndex(0);

			expect(mockLocator.nth).toHaveBeenCalledWith(0);
			expect(result).toBe(itemLocator);
		});

		it("itemType is instance calls cloneWithContext", () => {
			class Item extends PageObject {}
			const itemInstance = new Item(
				mockPage,
				mockRoot,
				vi.fn().mockReturnValue(mockLocator) as SelectorType,
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
	});

	describe("item resolution methods", () => {
		it("getItemByIndex(n) uses p => p.nth(n)", () => {
			const list = createList();
			list.getItemByIndex(3);
			expect(mockLocator.nth).toHaveBeenCalledWith(3);
		});

		it("getItemByIndex(-1) uses p => p.nth(-1)", () => {
			const list = createList();
			list.getItemByIndex(-1);
			expect(mockLocator.nth).toHaveBeenCalledWith(-1);
		});

		it("first() same as getItemByIndex(0)", () => {
			const list = createList();
			list.first();
			expect(mockLocator.nth).toHaveBeenCalledWith(0);
		});

		it("last() same as getItemByIndex(-1)", () => {
			const list = createList();
			list.last();
			expect(mockLocator.nth).toHaveBeenCalledWith(-1);
		});

		it("filter(options) uses p => p.filter(options)", () => {
			const list = createList();
			list.filter({ hasText: "foo" });
			expect(mockLocator.filter).toHaveBeenCalledWith({ hasText: "foo" });
		});

		it("filterByText(text) uses p => p.filter({ hasText })", () => {
			const list = createList();
			list.filterByText("bar");
			expect(mockLocator.filter).toHaveBeenCalledWith({ hasText: "bar" });
		});

		it("filterByTestId(id) uses p => p.filter({ has: page.getByTestId(id) })", () => {
			const list = createList();
			list.filterByTestId("myId");
			expect(mockLocator.filter).toHaveBeenCalledWith({
				has: expect.anything(),
			});
			expect(mockPage.getByTestId).toHaveBeenCalledWith("myId");
		});

		it("getItemByIdMask(mask) uses p => p.getByTestId(new RegExp(mask))", () => {
			const list = createList();
			list.getItemByIdMask("Item-");
			expect(mockLocator.getByTestId).toHaveBeenCalledWith(expect.any(RegExp));
		});

		it("getItemByText(text) uses p => p.getByText(text)", () => {
			const list = createList();
			list.getItemByText("hello");
			expect(mockLocator.getByText).toHaveBeenCalledWith("hello");
		});

		it("getItemByRole(...args) uses p => p.getByRole(...args)", () => {
			const list = createList();
			list.getItemByRole("button", { name: "Submit" });
			expect(mockLocator.getByRole).toHaveBeenCalledWith("button", {
				name: "Submit",
			});
		});
	});

	describe("at()", () => {
		it("at(n) delegates to getItemByIndex(n)", () => {
			const list = createList();
			list.at(2);
			expect(mockLocator.nth).toHaveBeenCalledWith(2);
		});

		it("at(-1) delegates to getItemByIndex(-1)", () => {
			const list = createList();
			list.at(-1);
			expect(mockLocator.nth).toHaveBeenCalledWith(-1);
		});

		it("at(-2) uses p.nth(-2)", () => {
			const list = createList();
			list.at(-2);
			expect(mockLocator.nth).toHaveBeenCalledWith(-2);
		});

		it("first() same as at(0)", () => {
			const list = createList();
			list.first();
			expect(mockLocator.nth).toHaveBeenCalledWith(0);
		});

		it("last() same as at(-1)", () => {
			const list = createList();
			list.last();
			expect(mockLocator.nth).toHaveBeenCalledWith(-1);
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
			list.items.at(-2);
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
	});
});
