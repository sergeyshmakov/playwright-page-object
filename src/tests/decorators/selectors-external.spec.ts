import type { Locator, Page } from "@playwright/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RootSelector } from "../../decorators/rootSelectors";
import { Selector, SelectorByRole } from "../../decorators/selectors";
import { PageObject } from "../../page-objects/PageObject";
import { RootPageObject } from "../../page-objects/RootPageObject";
import { createMockLocator, createMockPage } from "../mocks/playwright";

class ExternalButton {
	constructor(public readonly locator: Locator) {}
}

class ExternalInput {
	constructor(
		public readonly locator: Locator,
		public readonly placeholder: string,
	) {}
}

describe("selectors with external controls (no PageObject base)", () => {
	let mockPage: ReturnType<typeof createMockPage>;
	let bodyLocator: ReturnType<typeof createMockLocator>;

	beforeEach(() => {
		mockPage = createMockPage();
		bodyLocator = createMockLocator(mockPage);
		bodyLocator.page = vi.fn().mockReturnValue(mockPage);
		mockPage.locator = vi.fn().mockReturnValue(bodyLocator);
	});

	describe("trailing constructor argument", () => {
		it("instantiates an external control with the resolved locator", () => {
			const roleLocator = createMockLocator(mockPage);
			bodyLocator.getByRole = vi.fn().mockReturnValue(roleLocator);

			@RootSelector()
			class TestPage extends RootPageObject {
				@SelectorByRole("button", { name: "Remove" }, ExternalButton)
				accessor removeBtn = undefined as unknown as ExternalButton;
			}

			const page = new TestPage(mockPage);
			const result = page.removeBtn;

			expect(result).toBeInstanceOf(ExternalButton);
			expect((result as ExternalButton).locator).toBe(roleLocator);
		});

		it("creates a new instance on each accessor access", () => {
			@RootSelector()
			class TestPage extends RootPageObject {
				@Selector("btn", ExternalButton)
				accessor btn = undefined as unknown as ExternalButton;
			}

			const page = new TestPage(mockPage);
			const a = page.btn;
			const b = page.btn;

			expect(a).not.toBe(b);
			expect(a).toBeInstanceOf(ExternalButton);
			expect(b).toBeInstanceOf(ExternalButton);
		});
	});

	describe("trailing factory argument", () => {
		it("instantiates an external control through a factory", () => {
			const inputLocator = createMockLocator(mockPage);
			bodyLocator.getByTestId = vi.fn().mockReturnValue(inputLocator);

			@RootSelector()
			class TestPage extends RootPageObject {
				@Selector(
					"EmailInput",
					(locator) => new ExternalInput(locator, "Enter email"),
				)
				accessor emailInput = undefined as unknown as ExternalInput;
			}

			const page = new TestPage(mockPage);
			const result = page.emailInput;

			expect(result).toBeInstanceOf(ExternalInput);
			expect((result as ExternalInput).locator).toBe(inputLocator);
			expect((result as ExternalInput).placeholder).toBe("Enter email");
		});

		it("factory closure captures variables correctly", () => {
			const label = "captured-label";

			@RootSelector()
			class TestPage extends RootPageObject {
				@Selector("Input", (locator) => new ExternalInput(locator, label))
				accessor input = undefined as unknown as ExternalInput;
			}

			const page = new TestPage(mockPage);
			const result = page.input as ExternalInput;
			expect(result.placeholder).toBe("captured-label");
		});
	});

	describe("external root class path", () => {
		it("supports selector decorators on a root class without PageObject base", () => {
			const childLocator = createMockLocator(mockPage);
			bodyLocator.getByTestId = vi.fn().mockReturnValue(childLocator);

			@RootSelector()
			class ExternalRootPage {
				constructor(readonly page: Page) {}

				@Selector("MyControl", ExternalButton)
				accessor myControl = undefined as unknown as ExternalButton;
			}

			const page = new ExternalRootPage(mockPage);
			const result = page.myControl;

			expect(result).toBeInstanceOf(ExternalButton);
			expect((result as ExternalButton).locator).toBe(childLocator);
			expect(bodyLocator.getByTestId).toHaveBeenCalledWith("MyControl");
		});

		it("preserves page-first custom constructor args on external root classes", () => {
			const childLocator = createMockLocator(mockPage);
			bodyLocator.getByTestId = vi.fn().mockReturnValue(childLocator);

			@RootSelector()
			class ExternalRootPage {
				constructor(
					readonly page: Page,
					readonly label: string,
				) {}

				@Selector("MyControl", ExternalButton)
				accessor myControl = undefined as unknown as ExternalButton;
			}

			const page = new ExternalRootPage(mockPage, "checkout");
			const result = page.myControl;

			expect(page.label).toBe("checkout");
			expect(result).toBeInstanceOf(ExternalButton);
			expect((result as ExternalButton).locator).toBe(childLocator);
			expect(bodyLocator.getByTestId).toHaveBeenCalledWith("MyControl");
		});
	});

	describe("backward compatibility — PageObject instances unchanged", () => {
		it("PageObject child still uses cloneWithContext", () => {
			class ChildControl extends PageObject {}
			const childInstance = new ChildControl();
			const cloneSpy = vi.spyOn(childInstance, "cloneWithContext");

			@RootSelector()
			class TestPage extends RootPageObject {
				@Selector("child")
				accessor child = childInstance;
			}

			const page = new TestPage(mockPage);
			page.child;

			expect(cloneSpy).toHaveBeenCalledWith(bodyLocator, expect.any(Function));
		});
	});
});
