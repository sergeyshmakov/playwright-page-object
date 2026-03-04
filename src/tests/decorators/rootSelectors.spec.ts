import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    ListRootSelector,
    RootSelector,
    RootSelectorByAltText,
    RootSelectorByLabel,
    RootSelectorByPlaceholder,
    RootSelectorByRole,
    RootSelectorByText,
    RootSelectorByTitle,
} from "../../decorators/rootSelectors";
import { PageObject } from "../../page-objects/PageObject";
import { createMockLocator, createMockPage } from "../mocks/playwright";

describe("RootSelectorBy (via exported wrappers)", () => {
    let mockPage: ReturnType<typeof createMockPage>;
    let bodyLocator: ReturnType<typeof createMockLocator>;

    beforeEach(() => {
        mockPage = createMockPage();
        bodyLocator = createMockLocator(mockPage as any);
        bodyLocator.page = vi.fn().mockReturnValue(mockPage);
        mockPage.locator = vi.fn().mockReturnValue(bodyLocator);
    });

    it("overrides constructor to pass page.locator('body') and selector", () => {
        @RootSelector("container")
        class TestPage extends PageObject {}

        new TestPage(mockPage as any);

        expect(mockPage.locator).toHaveBeenCalledWith("body");
    });

    it("throws when used on non-class", () => {
        const decorator = RootSelector("id");

        const target = class {};
        const context = {
            kind: "method" as const,
            name: "test",
            metadata: {},
            addInitializer: vi.fn(),
            static: false,
            private: false,
        };

        expect(() => decorator(target as any, context as any)).toThrow(
            /can be used only with class.*method/,
        );
    });

    it("RootSelector(id) uses p.getByTestId(id)", () => {
        @RootSelector("myId")
        class TestPage extends PageObject {}

        const instance = new TestPage(mockPage as any);
        (instance as any).locator;

        expect(bodyLocator.getByTestId).toHaveBeenCalledWith("myId");
    });

    it("RootSelector() without id uses identity selector p => p", () => {
        @RootSelector()
        class TestPage extends PageObject {}

        const instance = new TestPage(mockPage as any);
        const loc = (instance as any).locator;

        expect(loc).toBe(bodyLocator);
    });

    it("ListRootSelector(id) uses p.getByTestId(new RegExp(id))", () => {
        @ListRootSelector("Item")
        class TestPage extends PageObject {}

        const instance = new TestPage(mockPage as any);
        (instance as any).locator;

        expect(bodyLocator.getByTestId).toHaveBeenCalledWith(
            expect.any(RegExp),
        );
        expect(
            (bodyLocator.getByTestId as ReturnType<typeof vi.fn>).mock
                .calls[0][0].source,
        ).toBe("Item");
    });

    it("RootSelectorByText(text) uses p.getByText(text)", () => {
        @RootSelectorByText("Submit")
        class TestPage extends PageObject {}

        const instance = new TestPage(mockPage as any);
        (instance as any).locator;

        expect(bodyLocator.getByText).toHaveBeenCalledWith("Submit");
    });

    it("RootSelectorByRole(...args) uses p.getByRole(...args)", () => {
        @RootSelectorByRole("button", { name: "Submit" })
        class TestPage extends PageObject {}

        const instance = new TestPage(mockPage as any);
        (instance as any).locator;

        expect(bodyLocator.getByRole).toHaveBeenCalledWith("button", {
            name: "Submit",
        });
    });

    it("RootSelectorByLabel(...args) uses p.getByLabel(...args)", () => {
        @RootSelectorByLabel("Username")
        class TestPage extends PageObject {}

        const instance = new TestPage(mockPage as any);
        (instance as any).locator;

        expect(bodyLocator.getByLabel).toHaveBeenCalledWith("Username");
    });

    it("RootSelectorByPlaceholder(...args) uses p.getByPlaceholder(...args)", () => {
        @RootSelectorByPlaceholder("Enter text")
        class TestPage extends PageObject {}

        const instance = new TestPage(mockPage as any);
        (instance as any).locator;

        expect(bodyLocator.getByPlaceholder).toHaveBeenCalledWith("Enter text");
    });

    it("RootSelectorByAltText(...args) uses p.getByAltText(...args)", () => {
        @RootSelectorByAltText("Logo")
        class TestPage extends PageObject {}

        const instance = new TestPage(mockPage as any);
        (instance as any).locator;

        expect(bodyLocator.getByAltText).toHaveBeenCalledWith("Logo");
    });

    it("RootSelectorByTitle(...args) uses p.getByTitle(...args)", () => {
        @RootSelectorByTitle("Tooltip")
        class TestPage extends PageObject {}

        const instance = new TestPage(mockPage as any);
        (instance as any).locator;

        expect(bodyLocator.getByTitle).toHaveBeenCalledWith("Tooltip");
    });
});
