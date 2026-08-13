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

		it("throws when itemType is a non-PageObject value", () => {
			expect(() => {
				new ListPageObject(
					42 as unknown as PageObject,
					mockRoot as unknown as Locator,
					selector,
				);
			}).toThrow(/itemType must be a PageObject/);
		});

		it("throws when itemType is a plain function (not PageObject subclass)", () => {
			const factory = (_root?: Locator) => new PageObject();
			expect(() => {
				new ListPageObject(
					factory as unknown as PageObject,
					mockRoot as unknown as Locator,
					selector,
				);
			}).toThrow(/itemType must be a PageObject/);
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

		it("filterByText(RegExp) passes regex to filter", () => {
			const filteredLocator = createMockLocator(mockPage);
			mockLocator.filter = vi.fn().mockReturnValue(filteredLocator);
			const pattern = /widget/i;
			const list = createList();

			const result = list.filterByText(pattern);

			expect(result).toBeInstanceOf(ListPageObject);
			expect(result.$).toBe(filteredLocator);
			expect(mockLocator.filter).toHaveBeenCalledWith({ hasText: pattern });
		});

		it("filterByItemTestId(id) returns a narrowed list matching item test ids", () => {
			const pageTestIdLocator = createMockLocator(mockPage);
			const filteredLocator = createMockLocator(mockPage);
			mockPage.getByTestId = vi.fn().mockReturnValue(pageTestIdLocator);
			mockLocator.and = vi.fn().mockReturnValue(filteredLocator);
			const list = createList();

			const result = list.filterByItemTestId("myId");

			expect(result).toBeInstanceOf(ListPageObject);
			expect(result.$).toBe(filteredLocator);
			expect(mockPage.getByTestId).toHaveBeenCalledWith("myId");
			expect(mockLocator.and).toHaveBeenCalledWith(pageTestIdLocator);
		});

		it("filterByItemTestId(RegExp) passes regex to getByTestId", () => {
			const pageTestIdLocator = createMockLocator(mockPage);
			const filteredLocator = createMockLocator(mockPage);
			mockPage.getByTestId = vi.fn().mockReturnValue(pageTestIdLocator);
			mockLocator.and = vi.fn().mockReturnValue(filteredLocator);
			const pattern = /CartItem_\d+/;
			const list = createList();

			const result = list.filterByItemTestId(pattern);
			expect(result.$).toBe(filteredLocator);
			expect(mockPage.getByTestId).toHaveBeenCalledWith(pattern);
		});

		it("filterByHasTestId(id) returns a narrowed list matching Playwright has test ids", () => {
			const pageTestIdLocator = createMockLocator(mockPage);
			const filteredLocator = createMockLocator(mockPage);
			mockPage.getByTestId = vi.fn().mockReturnValue(pageTestIdLocator);
			mockLocator.filter = vi.fn().mockReturnValue(filteredLocator);
			const list = createList();

			const result = list.filterByHasTestId("myChildId");

			expect(result).toBeInstanceOf(ListPageObject);
			expect(result.$).toBe(filteredLocator);
			expect(mockPage.getByTestId).toHaveBeenCalledWith("myChildId");
			expect(mockLocator.getByTestId).not.toHaveBeenCalled();
			expect(mockLocator.filter).toHaveBeenCalledWith({
				has: pageTestIdLocator,
			});
		});

		it("getItemByTestId(id) returns the first matched item from the filtered list", () => {
			const pageTestIdLocator = createMockLocator(mockPage);
			const filteredLocator = createMockLocator(mockPage);
			mockPage.getByTestId = vi.fn().mockReturnValue(pageTestIdLocator);
			mockLocator.and = vi.fn().mockReturnValue(filteredLocator);
			const list = createList();

			void list.getItemByTestId("myId").$;

			expect(mockPage.getByTestId).toHaveBeenCalledWith("myId");
			expect(mockLocator.and).toHaveBeenCalledWith(pageTestIdLocator);
			expect(filteredLocator.nth).toHaveBeenCalledWith(0);
		});

		it("getItemByTestId(RegExp) passes regex through to filterByItemTestId", () => {
			const pageTestIdLocator = createMockLocator(mockPage);
			const filteredLocator = createMockLocator(mockPage);
			mockPage.getByTestId = vi.fn().mockReturnValue(pageTestIdLocator);
			mockLocator.and = vi.fn().mockReturnValue(filteredLocator);
			const pattern = /CartItem_\d+/;
			const list = createList();

			void list.getItemByTestId(pattern).$;

			expect(mockPage.getByTestId).toHaveBeenCalledWith(pattern);
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

		it("getItemByRole(...args) returns the first item containing a matching role", () => {
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
});
