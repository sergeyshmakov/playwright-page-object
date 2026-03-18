import type { Locator } from "@playwright/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RootSelector } from "../../decorators/rootSelectors";
import {
	ListSelector,
	ListStrictSelector,
	Selector,
	SelectorByAltText,
	SelectorByLabel,
	SelectorByPlaceholder,
	SelectorByRole,
	SelectorByText,
	SelectorByTitle,
} from "../../decorators/selectors";
import { PageObject, type SelectorType } from "../../page-objects/PageObject";
import { RootPageObject } from "../../page-objects/RootPageObject";
import { createMockLocator, createMockPage } from "../mocks/playwright";

describe("selectors (ListSelector, Selector, etc.)", () => {
	let mockPage: ReturnType<typeof createMockPage>;
	let bodyLocator: ReturnType<typeof createMockLocator>;

	function getLocator<TPageObject extends PageObject>(pageObject: TPageObject) {
		return (pageObject as unknown as TPageObject & { locator: Locator })
			.locator;
	}

	beforeEach(() => {
		mockPage = createMockPage();
		bodyLocator = createMockLocator(mockPage);
		bodyLocator.page = vi.fn().mockReturnValue(mockPage);
		mockPage.locator = vi.fn().mockReturnValue(bodyLocator);
	});

	describe("ListSelector", () => {
		it("for Locator value returns root.getByTestId(new RegExp(mask))", () => {
			@RootSelector()
			class TestPage extends RootPageObject {
				@ListSelector("Item")
				accessor items = bodyLocator as unknown as Locator;
			}

			const instance = new TestPage(mockPage);
			instance.items;

			expect(bodyLocator.getByTestId).toHaveBeenCalledWith(expect.any(RegExp));
			expect(
				(bodyLocator.getByTestId as ReturnType<typeof vi.fn>).mock.calls[0][0]
					.source,
			).toBe("Item");
		});

		it("for PageObject value calls cloneWithContext(root, selector)", () => {
			class ItemPageObject extends PageObject {}
			const itemInstance = new ItemPageObject(
				bodyLocator,
				vi.fn().mockReturnValue(bodyLocator) as SelectorType,
			);
			const cloneWithContextSpy = vi.spyOn(itemInstance, "cloneWithContext");

			@RootSelector()
			class TestPage extends RootPageObject {
				@ListSelector("Item")
				accessor items = itemInstance;
			}

			const instance = new TestPage(mockPage);
			instance.items;

			expect(cloneWithContextSpy).toHaveBeenCalledWith(
				bodyLocator,
				expect.any(Function),
			);
		});
	});

	describe("ListStrictSelector", () => {
		it("uses exact getByTestId(id)", () => {
			@RootSelector()
			class TestPage extends RootPageObject {
				@ListStrictSelector("exactItem")
				accessor items = bodyLocator as unknown as Locator;
			}

			const instance = new TestPage(mockPage);
			instance.items;

			expect(bodyLocator.getByTestId).toHaveBeenCalledWith("exactItem");
		});
	});

	describe("Selector", () => {
		it("with id uses getByTestId(id)", () => {
			@RootSelector()
			class TestPage extends RootPageObject {
				@Selector("myChild")
				accessor child = bodyLocator as unknown as Locator;
			}

			const instance = new TestPage(mockPage);
			instance.child;

			expect(bodyLocator.getByTestId).toHaveBeenCalledWith("myChild");
		});

		it("without id uses identity selector", () => {
			@RootSelector()
			class TestPage extends RootPageObject {
				@Selector()
				accessor child = bodyLocator as unknown as Locator;
			}

			const instance = new TestPage(mockPage);
			const result = instance.child;

			expect(result).toBe(bodyLocator);
		});
	});

	describe("SelectorByText", () => {
		it("uses getByText(text)", () => {
			@RootSelector()
			class TestPage extends RootPageObject {
				@SelectorByText("Hello")
				accessor child = bodyLocator as unknown as Locator;
			}

			const instance = new TestPage(mockPage);
			instance.child;

			expect(bodyLocator.getByText).toHaveBeenCalledWith("Hello");
		});
	});

	describe("SelectorByRole", () => {
		it("uses getByRole(...args)", () => {
			@RootSelector()
			class TestPage extends RootPageObject {
				@SelectorByRole("button", { name: "Click" })
				accessor child = bodyLocator as unknown as Locator;
			}

			const instance = new TestPage(mockPage);
			instance.child;

			expect(bodyLocator.getByRole).toHaveBeenCalledWith("button", {
				name: "Click",
			});
		});
	});

	describe("SelectorByLabel", () => {
		it("uses getByLabel(...args)", () => {
			@RootSelector()
			class TestPage extends RootPageObject {
				@SelectorByLabel("Email")
				accessor child = bodyLocator as unknown as Locator;
			}

			const instance = new TestPage(mockPage);
			instance.child;

			expect(bodyLocator.getByLabel).toHaveBeenCalledWith("Email");
		});
	});

	describe("SelectorByPlaceholder", () => {
		it("uses getByPlaceholder(...args)", () => {
			@RootSelector()
			class TestPage extends RootPageObject {
				@SelectorByPlaceholder("placeholder")
				accessor child = bodyLocator as unknown as Locator;
			}

			const instance = new TestPage(mockPage);
			instance.child;

			expect(bodyLocator.getByPlaceholder).toHaveBeenCalledWith("placeholder");
		});
	});

	describe("SelectorByAltText", () => {
		it("uses getByAltText(...args)", () => {
			@RootSelector()
			class TestPage extends RootPageObject {
				@SelectorByAltText("image")
				accessor child = bodyLocator as unknown as Locator;
			}

			const instance = new TestPage(mockPage);
			instance.child;

			expect(bodyLocator.getByAltText).toHaveBeenCalledWith("image");
		});
	});

	describe("SelectorByTitle", () => {
		it("uses getByTitle(...args)", () => {
			@RootSelector()
			class TestPage extends RootPageObject {
				@SelectorByTitle("title")
				accessor child = bodyLocator as unknown as Locator;
			}

			const instance = new TestPage(mockPage);
			instance.child;

			expect(bodyLocator.getByTitle).toHaveBeenCalledWith("title");
		});
	});

	describe("multiple accessors with same PageObject type", () => {
		it("two accessors of same type resolve to different elements", () => {
			class ItemPageObject extends PageObject {}

			@RootSelector()
			class TestPage extends RootPageObject {
				@Selector("item1")
				accessor item1 = new ItemPageObject(
					bodyLocator,
					vi.fn().mockReturnValue(bodyLocator) as SelectorType,
				);
				@Selector("item2")
				accessor item2 = new ItemPageObject(
					bodyLocator,
					vi.fn().mockReturnValue(bodyLocator) as SelectorType,
				);
			}

			const instance = new TestPage(mockPage);
			const result1 = instance.item1;
			const result2 = instance.item2;

			getLocator(result1);
			getLocator(result2);

			expect(bodyLocator.getByTestId).toHaveBeenNthCalledWith(1, "item1");
			expect(bodyLocator.getByTestId).toHaveBeenNthCalledWith(2, "item2");
		});

		it("verifies selector application is per-accessor", () => {
			class ItemPageObject extends PageObject {}

			@RootSelector()
			class TestPage extends RootPageObject {
				@Selector("item1")
				accessor item1 = new ItemPageObject(
					bodyLocator,
					vi.fn().mockReturnValue(bodyLocator) as SelectorType,
				);
				@Selector("item2")
				accessor item2 = new ItemPageObject(
					bodyLocator,
					vi.fn().mockReturnValue(bodyLocator) as SelectorType,
				);
			}

			const instance = new TestPage(mockPage);
			const result1 = instance.item1;
			const result2 = instance.item2;

			expect(PageObject.isInstance(result1)).toBe(true);
			expect(PageObject.isInstance(result2)).toBe(true);
			expect(result1).not.toBe(result2);
		});
	});

	describe("variable reuse in changed context (dynamic locator handling)", () => {
		it("same accessor path with different parent roots yields different bound elements", () => {
			class ChildPageObject extends PageObject {}

			const root1 = createMockLocator(mockPage);
			const root2 = createMockLocator(mockPage);
			root1.page = vi.fn().mockReturnValue(mockPage);
			root2.page = vi.fn().mockReturnValue(mockPage);

			const child = new ChildPageObject(
				root1,
				vi.fn().mockReturnValue(root1) as SelectorType,
			);
			const childSelector: SelectorType = (locator) =>
				locator.getByTestId("child");

			const child1 = child.cloneWithContext(root1, childSelector);
			const child2 = child.cloneWithContext(root2, childSelector);

			expect(child1.root).toBe(root1);
			expect(child2.root).toBe(root2);
			expect(child1.root).not.toBe(child2.root);
		});

		it("reusing accessor when parent context changes", async () => {
			class ItemPageObject extends PageObject {
				@Selector("child")
				accessor child = new PageObject(
					bodyLocator,
					vi.fn().mockReturnValue(bodyLocator) as SelectorType,
				);
			}

			const listLocator = createMockLocator(mockPage);
			const item0Locator = createMockLocator(mockPage);
			const item1Locator = createMockLocator(mockPage);
			listLocator.nth = vi
				.fn()
				.mockImplementation((n: number) =>
					n === 0 ? item0Locator : item1Locator,
				);

			const listSelector: SelectorType = vi.fn().mockReturnValue(listLocator);
			const { ListPageObject } = await import(
				"../../page-objects/ListPageObject.js"
			);
			const list = new ListPageObject(
				ItemPageObject,
				bodyLocator,
				listSelector,
			);

			const item0 = list.getItemByIndex(0);
			const item1 = list.getItemByIndex(1);

			const child0 = item0.child;
			const child1 = item1.child;

			expect(child0).not.toBe(child1);
			expect(child0.root).toBe(item0Locator);
			expect(child1.root).toBe(item1Locator);
		});

		it("accessor getter re-evaluates on each access", () => {
			class ChildPageObject extends PageObject {}

			const root1 = createMockLocator(mockPage);
			const root2 = createMockLocator(mockPage);
			root1.page = vi.fn().mockReturnValue(mockPage);
			root2.page = vi.fn().mockReturnValue(mockPage);

			class ParentPage extends PageObject {
				@Selector("child")
				accessor child = new ChildPageObject(
					bodyLocator,
					vi.fn().mockReturnValue(bodyLocator) as SelectorType,
				);
			}

			const selector1: SelectorType = vi.fn().mockReturnValue(root1);
			const selector2: SelectorType = vi.fn().mockReturnValue(root2);

			const parent1 = new ParentPage(root1, selector1);
			const parent2 = new ParentPage(root2, selector2);

			const child1 = parent1.child;
			const child2 = parent2.child;

			expect(child1.root).toBe(root1);
			expect(child2.root).toBe(root2);
			expect(child1.root).not.toBe(child2.root);
		});
	});
});
