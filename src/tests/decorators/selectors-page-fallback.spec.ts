import type { Locator, Page } from "@playwright/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Selector, SelectorByText } from "../../decorators/selectors";
import { PageObject, type SelectorType } from "../../page-objects/PageObject";
import { createMockLocator, createMockPage } from "../mocks/playwright";

describe("selectors with optional host `page` or `locator` (no @RootSelector)", () => {
	let mockPage: ReturnType<typeof createMockPage>;
	let bodyLocator: ReturnType<typeof createMockLocator>;

	beforeEach(() => {
		mockPage = createMockPage();
		bodyLocator = createMockLocator(mockPage);
		bodyLocator.page = vi.fn().mockReturnValue(mockPage);
		mockPage.locator = vi.fn().mockReturnValue(bodyLocator);
	});

	it("uses page.locator('body') then getByTestId for @Selector", () => {
		class TestHost {
			constructor(readonly page: Page) {}

			@Selector("myChild")
			accessor child = bodyLocator as unknown as Locator;
		}

		const instance = new TestHost(mockPage);
		instance.child;

		expect(mockPage.locator).toHaveBeenCalledWith("body");
		expect(bodyLocator.getByTestId).toHaveBeenCalledWith("myChild");
	});

	it("passes body Locator into cloneWithContext for nested PageObject", () => {
		class Child extends PageObject {}
		const childInstance = new Child(
			bodyLocator,
			vi.fn().mockReturnValue(bodyLocator) as SelectorType,
		);
		const cloneWithContextSpy = vi.spyOn(childInstance, "cloneWithContext");

		class TestHost {
			constructor(readonly page: Page) {}

			@Selector("wrap")
			accessor wrapped = childInstance;
		}

		new TestHost(mockPage).wrapped;

		expect(mockPage.locator).toHaveBeenCalledWith("body");
		expect(cloneWithContextSpy).toHaveBeenCalledWith(
			bodyLocator,
			expect.any(Function),
		);
	});

	it("uses body root for @SelectorByText", () => {
		class TestHost {
			constructor(readonly page: Page) {}

			@SelectorByText("Hello")
			accessor label = bodyLocator as unknown as Locator;
		}

		new TestHost(mockPage).label;

		expect(mockPage.locator).toHaveBeenCalledWith("body");
		expect(bodyLocator.getByText).toHaveBeenCalledWith("Hello");
	});

	it("uses Locator-like `locator` for nested @Selector on a fragment class", () => {
		const containerLoc = createMockLocator(mockPage);
		containerLoc.page = vi.fn().mockReturnValue(mockPage);
		bodyLocator.getByTestId = vi.fn().mockReturnValue(containerLoc);

		class ContainerFragment {
			constructor(readonly locator: Locator) {}

			@Selector("inner")
			accessor inner = bodyLocator as unknown as Locator;
		}

		class TestHost {
			constructor(readonly page: Page) {}

			@Selector("container", ContainerFragment)
			accessor box!: ContainerFragment;
		}

		new TestHost(mockPage).box.inner;

		expect(mockPage.locator).toHaveBeenCalledWith("body");
		expect(bodyLocator.getByTestId).toHaveBeenCalledWith("container");
		expect(containerLoc.getByTestId).toHaveBeenCalledWith("inner");
	});

	it("prefers `locator` over `page` when both are present", () => {
		const fragmentRoot = createMockLocator(mockPage);
		fragmentRoot.page = vi.fn().mockReturnValue(mockPage);

		class BothHost {
			constructor(
				readonly locator: Locator,
				readonly page: Page,
			) {}

			@Selector("x")
			accessor child = bodyLocator as unknown as Locator;
		}

		(mockPage.locator as ReturnType<typeof vi.fn>).mockClear();

		new BothHost(fragmentRoot, mockPage).child;

		expect(fragmentRoot.getByTestId).toHaveBeenCalledWith("x");
		expect(mockPage.locator).not.toHaveBeenCalled();
	});

	it("throws when host has no LOCATOR_SYMBOL, Locator-like locator, nor Playwright page", () => {
		class BadHost {
			@Selector("x")
			accessor x!: Locator;
		}

		expect(() => {
			void new BadHost().x;
		}).toThrow(/LOCATOR_SYMBOL/);
	});
});
