import type { Locator, Page } from "@playwright/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RootSelector } from "../../decorators/rootSelectors";
import { Selector } from "../../decorators/selectors";
import { PageObject, type SelectorType } from "../../page-objects/PageObject";
import { RootPageObject } from "../../page-objects/RootPageObject";
import { createMockLocator, createMockPage } from "../mocks/playwright";

describe("PageObject advanced behavior", () => {
	let mockPage: ReturnType<typeof createMockPage>;
	let bodyLocator: ReturnType<typeof createMockLocator>;

	beforeEach(() => {
		mockPage = createMockPage();
		bodyLocator = createMockLocator(mockPage);
		bodyLocator.page = vi.fn().mockReturnValue(mockPage);
		mockPage.locator = vi.fn().mockReturnValue(bodyLocator);
	});

	it("keeps host root separate from overridden locator", () => {
		const triggerLocator = createMockLocator(mockPage);
		const visibleTriggerLocator = createMockLocator(mockPage);
		const popupLocator = createMockLocator(mockPage);

		bodyLocator.getByTestId = vi.fn().mockReturnValue(triggerLocator);
		triggerLocator.locator = vi.fn().mockReturnValue(visibleTriggerLocator);
		mockPage.getByTestId = vi.fn().mockReturnValue(popupLocator);

		class PopupControl extends PageObject {
			override get locator(): Locator {
				const page = this.page;
				if (!page) {
					throw new Error("PopupControl requires page");
				}
				return page.getByTestId("PopupContent") as Locator;
			}

			get tooltipElement(): Locator {
				return (this.root as Locator).locator("visible=true") as Locator;
			}
		}

		class TriggerControl extends PageObject {
			@Selector()
			accessor popup = new PopupControl();
		}

		@RootSelector()
		class TestPage extends RootPageObject {
			@Selector("trigger")
			accessor trigger = new TriggerControl();
		}

		const page = new TestPage(mockPage);
		const popup = (page.trigger as TriggerControl).popup as PopupControl;

		expect(popup.root).toBe(triggerLocator);
		expect(popup.tooltipElement).toBe(visibleTriggerLocator);
		expect(triggerLocator.locator).toHaveBeenCalledWith("visible=true");
		expect(popup.$).toBe(popupLocator);
		expect(mockPage.getByTestId).toHaveBeenCalledWith("PopupContent");
	});

	it("supports empty Selector with locator override rooted at host element", () => {
		const spinnerLocator = createMockLocator(mockPage);
		bodyLocator.getByTestId = vi.fn().mockReturnValue(spinnerLocator);

		class SpinnerControl extends PageObject {
			override get locator(): Locator {
				const root = this.root;
				if (!root) {
					throw new Error("SpinnerControl requires root");
				}
				return root.getByTestId("Spinner__root");
			}
		}

		@RootSelector()
		class TestPage extends RootPageObject {
			@Selector()
			accessor spinner = new SpinnerControl();
		}

		const page = new TestPage(mockPage);
		const spinner = page.spinner as SpinnerControl;

		expect(spinner.root).toBe(bodyLocator);
		expect(spinner.$).toBe(spinnerLocator);
		expect(bodyLocator.getByTestId).toHaveBeenCalledWith("Spinner__root");
	});

	it("honors cloneWithContext overrides for custom constructors", () => {
		class NamedChild extends PageObject {
			constructor(
				readonly label: string,
				page?: Page,
				root?: Locator,
				selector?: SelectorType,
			) {
				super(page, root, selector);
			}

			override cloneWithContext(root: Locator, selector: SelectorType): this {
				return new NamedChild(this.label, root.page(), root, selector) as this;
			}
		}

		const childTemplate = new NamedChild("kept-label");

		@RootSelector()
		class TestPage extends RootPageObject {
			@Selector("child")
			accessor child = childTemplate;
		}

		const page = new TestPage(mockPage);
		const result = page.child as NamedChild;

		expect(result).not.toBe(childTemplate);
		expect(result.label).toBe("kept-label");
		expect(result.root).toBe(bodyLocator);

		result.$;
		expect(bodyLocator.getByTestId).toHaveBeenCalledWith("child");
	});

	it("preserves page-first custom constructor args on root-decorated PageObjects", () => {
		const childLocator = createMockLocator(mockPage);
		bodyLocator.getByTestId = vi.fn().mockReturnValue(childLocator);

		@RootSelector()
		class NamedRootPage extends RootPageObject {
			constructor(
				page: Page,
				readonly label: string,
			) {
				super(page);
			}

			@Selector("child")
			accessor child = undefined as unknown as Locator;
		}

		const page = new NamedRootPage(mockPage, "kept-label");
		const child = page.child;

		expect(page.label).toBe("kept-label");
		expect(page.root).toBe(bodyLocator);
		expect(child).toBe(childLocator);
		expect(bodyLocator.getByTestId).toHaveBeenCalledWith("child");
	});
});
