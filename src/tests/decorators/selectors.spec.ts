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
import { PageObject } from "../../page-objects/PageObject";
import { createMockLocator, createMockPage } from "../mocks/playwright";

describe("selectors (ListSelector, Selector, etc.)", () => {
    let mockPage: ReturnType<typeof createMockPage>;
    let bodyLocator: ReturnType<typeof createMockLocator>;

    beforeEach(() => {
        mockPage = createMockPage();
        bodyLocator = createMockLocator(mockPage as any);
        bodyLocator.page = vi.fn().mockReturnValue(mockPage);
        mockPage.locator = vi.fn().mockReturnValue(bodyLocator);
    });

    describe("ListSelector", () => {
        it("for Locator value returns root.getByTestId(new RegExp(mask))", () => {
            @RootSelector()
            class TestPage extends PageObject {
                @ListSelector("Item")
                accessor items = bodyLocator as unknown as Locator;
            }

            const instance = new TestPage(mockPage as any);
            instance.items;

            expect(bodyLocator.getByTestId).toHaveBeenCalledWith(
                expect.any(RegExp),
            );
            expect(
                (bodyLocator.getByTestId as ReturnType<typeof vi.fn>).mock
                    .calls[0][0].source,
            ).toBe("Item");
        });

        it("for PageObject value calls cloneWithContext(root, selector)", () => {
            class ItemPageObject extends PageObject {}
            const itemInstance = new ItemPageObject(
                mockPage as any,
                bodyLocator as any,
                vi.fn() as any,
            );
            const cloneWithContextSpy = vi.spyOn(
                itemInstance,
                "cloneWithContext",
            );

            @RootSelector()
            class TestPage extends PageObject {
                @ListSelector("Item")
                accessor items = itemInstance;
            }

            const instance = new TestPage(mockPage as any);
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
            class TestPage extends PageObject {
                @ListStrictSelector("exactItem")
                accessor items = bodyLocator as unknown as Locator;
            }

            const instance = new TestPage(mockPage as any);
            instance.items;

            expect(bodyLocator.getByTestId).toHaveBeenCalledWith("exactItem");
        });
    });

    describe("Selector", () => {
        it("with id uses getByTestId(id)", () => {
            @RootSelector()
            class TestPage extends PageObject {
                @Selector("myChild")
                accessor child = bodyLocator as unknown as Locator;
            }

            const instance = new TestPage(mockPage as any);
            instance.child;

            expect(bodyLocator.getByTestId).toHaveBeenCalledWith("myChild");
        });

        it("without id uses identity selector", () => {
            @RootSelector()
            class TestPage extends PageObject {
                @Selector()
                accessor child = bodyLocator as unknown as Locator;
            }

            const instance = new TestPage(mockPage as any);
            const result = instance.child;

            expect(result).toBe(bodyLocator);
        });
    });

    describe("SelectorByText", () => {
        it("uses getByText(text)", () => {
            @RootSelector()
            class TestPage extends PageObject {
                @SelectorByText("Hello")
                accessor child = bodyLocator as unknown as Locator;
            }

            const instance = new TestPage(mockPage as any);
            instance.child;

            expect(bodyLocator.getByText).toHaveBeenCalledWith("Hello");
        });
    });

    describe("SelectorByRole", () => {
        it("uses getByRole(...args)", () => {
            @RootSelector()
            class TestPage extends PageObject {
                @SelectorByRole("button", { name: "Click" })
                accessor child = bodyLocator as unknown as Locator;
            }

            const instance = new TestPage(mockPage as any);
            instance.child;

            expect(bodyLocator.getByRole).toHaveBeenCalledWith("button", {
                name: "Click",
            });
        });
    });

    describe("SelectorByLabel", () => {
        it("uses getByLabel(...args)", () => {
            @RootSelector()
            class TestPage extends PageObject {
                @SelectorByLabel("Email")
                accessor child = bodyLocator as unknown as Locator;
            }

            const instance = new TestPage(mockPage as any);
            instance.child;

            expect(bodyLocator.getByLabel).toHaveBeenCalledWith("Email");
        });
    });

    describe("SelectorByPlaceholder", () => {
        it("uses getByPlaceholder(...args)", () => {
            @RootSelector()
            class TestPage extends PageObject {
                @SelectorByPlaceholder("placeholder")
                accessor child = bodyLocator as unknown as Locator;
            }

            const instance = new TestPage(mockPage as any);
            instance.child;

            expect(bodyLocator.getByPlaceholder).toHaveBeenCalledWith(
                "placeholder",
            );
        });
    });

    describe("SelectorByAltText", () => {
        it("uses getByAltText(...args)", () => {
            @RootSelector()
            class TestPage extends PageObject {
                @SelectorByAltText("image")
                accessor child = bodyLocator as unknown as Locator;
            }

            const instance = new TestPage(mockPage as any);
            instance.child;

            expect(bodyLocator.getByAltText).toHaveBeenCalledWith("image");
        });
    });

    describe("SelectorByTitle", () => {
        it("uses getByTitle(...args)", () => {
            @RootSelector()
            class TestPage extends PageObject {
                @SelectorByTitle("title")
                accessor child = bodyLocator as unknown as Locator;
            }

            const instance = new TestPage(mockPage as any);
            instance.child;

            expect(bodyLocator.getByTitle).toHaveBeenCalledWith("title");
        });
    });

    describe("multiple accessors with same PageObject type", () => {
        it("two accessors of same type resolve to different elements", () => {
            class ItemPageObject extends PageObject {}

            @RootSelector()
            class TestPage extends PageObject {
                @Selector("item1")
                accessor item1 = new ItemPageObject(
                    mockPage as any,
                    bodyLocator as any,
                    vi.fn() as any,
                );
                @Selector("item2")
                accessor item2 = new ItemPageObject(
                    mockPage as any,
                    bodyLocator as any,
                    vi.fn() as any,
                );
            }

            const instance = new TestPage(mockPage as any);
            const result1 = instance.item1;
            const result2 = instance.item2;

            (result1 as any).locator;
            (result2 as any).locator;

            expect(bodyLocator.getByTestId).toHaveBeenNthCalledWith(1, "item1");
            expect(bodyLocator.getByTestId).toHaveBeenNthCalledWith(2, "item2");
        });

        it("verifies selector application is per-accessor", () => {
            class ItemPageObject extends PageObject {}

            @RootSelector()
            class TestPage extends PageObject {
                @Selector("item1")
                accessor item1 = new ItemPageObject(
                    mockPage as any,
                    bodyLocator as any,
                    vi.fn() as any,
                );
                @Selector("item2")
                accessor item2 = new ItemPageObject(
                    mockPage as any,
                    bodyLocator as any,
                    vi.fn() as any,
                );
            }

            const instance = new TestPage(mockPage as any);
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

            const root1 = createMockLocator(mockPage as any);
            const root2 = createMockLocator(mockPage as any);
            root1.page = vi.fn().mockReturnValue(mockPage);
            root2.page = vi.fn().mockReturnValue(mockPage);

            const child = new ChildPageObject(
                mockPage as any,
                root1 as any,
                vi.fn() as any,
            );
            const childSelector = (p: any) => p.getByTestId("child");

            const child1 = child.cloneWithContext(root1 as any, childSelector);
            const child2 = child.cloneWithContext(root2 as any, childSelector);

            expect(child1.root).toBe(root1);
            expect(child2.root).toBe(root2);
            expect(child1.root).not.toBe(child2.root);
        });

        it("reusing accessor when parent context changes", async () => {
            class ItemPageObject extends PageObject {
                @Selector("child")
                accessor child = new PageObject(
                    mockPage as any,
                    bodyLocator as any,
                    vi.fn() as any,
                );
            }

            const listLocator = createMockLocator(mockPage as any);
            const item0Locator = createMockLocator(mockPage as any);
            const item1Locator = createMockLocator(mockPage as any);
            listLocator.nth = vi
                .fn()
                .mockImplementation((n: number) =>
                    n === 0 ? item0Locator : item1Locator,
                );

            const listSelector = vi.fn().mockReturnValue(listLocator);
            const { ListPageObject } =
                await import("../../page-objects/ListPageObject.js");
            const list = new ListPageObject(
                ItemPageObject,
                mockPage as any,
                bodyLocator as any,
                listSelector as any,
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

            const root1 = createMockLocator(mockPage as any);
            const root2 = createMockLocator(mockPage as any);
            root1.page = vi.fn().mockReturnValue(mockPage);
            root2.page = vi.fn().mockReturnValue(mockPage);

            class ParentPage extends PageObject {
                @Selector("child")
                accessor child = new ChildPageObject(
                    mockPage as any,
                    bodyLocator as any,
                    vi.fn() as any,
                );
            }

            const selector1 = vi.fn().mockReturnValue(root1);
            const selector2 = vi.fn().mockReturnValue(root2);

            const parent1 = new ParentPage(
                mockPage as any,
                root1 as any,
                selector1 as any,
            );
            const parent2 = new ParentPage(
                mockPage as any,
                root2 as any,
                selector2 as any,
            );

            const child1 = parent1.child;
            const child2 = parent2.child;

            expect(child1.root).toBe(root1);
            expect(child2.root).toBe(root2);
            expect(child1.root).not.toBe(child2.root);
        });
    });
});
