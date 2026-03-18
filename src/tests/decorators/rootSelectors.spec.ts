import type { Page } from "@playwright/test";
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
import { RootPageObject } from "../../page-objects/RootPageObject";
import { createMockLocator, createMockPage } from "../mocks/playwright";

describe("RootSelectorBy (via exported wrappers)", () => {
	let mockPage: ReturnType<typeof createMockPage>;
	let bodyLocator: ReturnType<typeof createMockLocator>;

	function getLocator(instance: RootPageObject) {
		return (
			instance as unknown as RootPageObject & { locator: typeof bodyLocator }
		).locator;
	}

	beforeEach(() => {
		mockPage = createMockPage();
		bodyLocator = createMockLocator(mockPage);
		bodyLocator.page = vi.fn().mockReturnValue(mockPage);
		mockPage.locator = vi.fn().mockReturnValue(bodyLocator);
	});

	it("overrides constructor to pass page.locator('body') and selector", () => {
		@RootSelector("container")
		class TestPage extends RootPageObject {}

		new TestPage(mockPage);

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
		const invokeDecorator = decorator as unknown as (
			target: unknown,
			context: unknown,
		) => unknown;

		expect(() => invokeDecorator(target, context)).toThrow(
			/can be used only with class.*method/,
		);
	});

	it("throws an explicit error when first constructor arg is not a Playwright Page", () => {
		@RootSelector()
		class ExternalRootPage {
			constructor(readonly page: Page) {}
		}

		expect(() => new ExternalRootPage(null as unknown as Page)).toThrow(
			/ExternalRootPage.*must receive Playwright Page as the first constructor argument/,
		);
	});

	it("rejects Locator values passed as the first constructor arg", () => {
		@RootSelector()
		class ExternalRootPage {
			constructor(readonly page: Page) {}
		}

		const locator = createMockLocator(mockPage);

		expect(() => new ExternalRootPage(locator as unknown as Page)).toThrow(
			/ExternalRootPage.*must receive Playwright Page as the first constructor argument/,
		);
		expect(locator.locator).not.toHaveBeenCalledWith("body");
	});

	it("RootSelector(id) uses p.getByTestId(id)", () => {
		@RootSelector("myId")
		class TestPage extends RootPageObject {}

		const instance = new TestPage(mockPage);
		getLocator(instance);

		expect(bodyLocator.getByTestId).toHaveBeenCalledWith("myId");
	});

	it("RootSelector() without id uses identity selector p => p", () => {
		@RootSelector()
		class TestPage extends RootPageObject {}

		const instance = new TestPage(mockPage);
		const loc = getLocator(instance);

		expect(loc).toBe(bodyLocator);
	});

	it("ListRootSelector(id) uses p.getByTestId(new RegExp(id))", () => {
		@ListRootSelector("Item")
		class TestPage extends RootPageObject {}

		const instance = new TestPage(mockPage);
		getLocator(instance);

		expect(bodyLocator.getByTestId).toHaveBeenCalledWith(expect.any(RegExp));
		expect(
			(bodyLocator.getByTestId as ReturnType<typeof vi.fn>).mock.calls[0][0]
				.source,
		).toBe("Item");
	});

	it("RootSelectorByText(text) uses p.getByText(text)", () => {
		@RootSelectorByText("Submit")
		class TestPage extends RootPageObject {}

		const instance = new TestPage(mockPage);
		getLocator(instance);

		expect(bodyLocator.getByText).toHaveBeenCalledWith("Submit");
	});

	it("RootSelectorByRole(...args) uses p.getByRole(...args)", () => {
		@RootSelectorByRole("button", { name: "Submit" })
		class TestPage extends RootPageObject {}

		const instance = new TestPage(mockPage);
		getLocator(instance);

		expect(bodyLocator.getByRole).toHaveBeenCalledWith("button", {
			name: "Submit",
		});
	});

	it("RootSelectorByLabel(...args) uses p.getByLabel(...args)", () => {
		@RootSelectorByLabel("Username")
		class TestPage extends RootPageObject {}

		const instance = new TestPage(mockPage);
		getLocator(instance);

		expect(bodyLocator.getByLabel).toHaveBeenCalledWith("Username");
	});

	it("RootSelectorByPlaceholder(...args) uses p.getByPlaceholder(...args)", () => {
		@RootSelectorByPlaceholder("Enter text")
		class TestPage extends RootPageObject {}

		const instance = new TestPage(mockPage);
		getLocator(instance);

		expect(bodyLocator.getByPlaceholder).toHaveBeenCalledWith("Enter text");
	});

	it("RootSelectorByAltText(...args) uses p.getByAltText(...args)", () => {
		@RootSelectorByAltText("Logo")
		class TestPage extends RootPageObject {}

		const instance = new TestPage(mockPage);
		getLocator(instance);

		expect(bodyLocator.getByAltText).toHaveBeenCalledWith("Logo");
	});

	it("RootSelectorByTitle(...args) uses p.getByTitle(...args)", () => {
		@RootSelectorByTitle("Tooltip")
		class TestPage extends RootPageObject {}

		const instance = new TestPage(mockPage);
		getLocator(instance);

		expect(bodyLocator.getByTitle).toHaveBeenCalledWith("Tooltip");
	});
});
