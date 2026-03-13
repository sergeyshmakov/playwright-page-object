import type { Locator, Page } from "@playwright/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PageObject, type SelectorType } from "../../page-objects/PageObject";
import { createMockLocator, createMockPage } from "../mocks/playwright";

const { mockPlaywrightExpect, mockPlaywrightExpectSoft } = vi.hoisted(() => {
	const chainReturn = {
		toBeVisible: vi.fn().mockResolvedValue(undefined),
		toBeHidden: vi.fn().mockResolvedValue(undefined),
		toHaveText: vi.fn().mockResolvedValue(undefined),
		toHaveValue: vi.fn().mockResolvedValue(undefined),
		toHaveAttribute: vi.fn().mockResolvedValue(undefined),
		not: {
			toHaveAttribute: vi.fn().mockResolvedValue(undefined),
			toBeChecked: vi.fn().mockResolvedValue(undefined),
		},
		toHaveCount: vi.fn().mockResolvedValue(undefined),
		toBeChecked: vi.fn().mockResolvedValue(undefined),
	};
	return {
		mockPlaywrightExpect: vi.fn().mockReturnValue(chainReturn),
		mockPlaywrightExpectSoft: vi.fn().mockReturnValue(chainReturn),
	};
});

vi.mock("@playwright/test", async () => {
	const actual =
		await vi.importActual<typeof import("@playwright/test")>(
			"@playwright/test",
		);
	return {
		...actual,
		expect: Object.assign(mockPlaywrightExpect, {
			soft: mockPlaywrightExpectSoft,
		}),
	};
});

describe("PageObject", () => {
	let mockPage: ReturnType<typeof createMockPage>;
	let mockRoot: ReturnType<typeof createMockLocator>;
	let mockLocator: ReturnType<typeof createMockLocator>;
	let selector: SelectorType;

	beforeEach(() => {
		vi.clearAllMocks();
		mockPage = createMockPage();
		mockRoot = createMockLocator(mockPage);
		mockLocator = createMockLocator(mockPage);
		mockRoot.page = vi.fn().mockReturnValue(mockPage);
		selector = vi.fn().mockReturnValue(mockLocator);
	});

	describe("constructor and core", () => {
		it("stores page, root, selector correctly", () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				selector,
			);
			expect(pageObj.page).toBe(mockPage);
			expect(pageObj.root).toBe(mockRoot);
		});

		it("locator getter returns selector(root) when selector is set", () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				selector,
			);
			const loc = (pageObj as unknown as { locator: Locator }).locator;
			expect(selector).toHaveBeenCalledWith(mockRoot);
			expect(loc).toBe(mockLocator);
		});

		it("locator getter throws when selector is empty with message containing class name", () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				undefined,
			);
			expect(
				() => (pageObj as unknown as { locator: Locator }).locator,
			).toThrow(/Empty selector.*PageObject/);
		});

		it("isClass returns true for PageObject subclass constructor", () => {
			class SubPageObject extends PageObject {}
			expect(PageObject.isClass(SubPageObject)).toBe(true);
		});

		it("isClass returns false for non-PageObject", () => {
			expect(PageObject.isClass({})).toBe(false);
			expect(PageObject.isClass(null)).toBe(false);
			expect(PageObject.isClass(undefined)).toBe(false);
			expect(PageObject.isClass(class Foo {})).toBe(false);
		});

		it("isInstance returns true for PageObject instance", () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				selector,
			);
			expect(PageObject.isInstance(pageObj)).toBe(true);
		});

		it("isInstance returns false for class, null, undefined", () => {
			expect(PageObject.isInstance(PageObject)).toBe(false);
			expect(PageObject.isInstance(null)).toBe(false);
			expect(PageObject.isInstance(undefined)).toBe(false);
		});

		it("cloneWithContext creates new instance with root.page(), root, selector", () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				selector,
			);
			const newRoot = createMockLocator(mockPage);
			newRoot.page = vi.fn().mockReturnValue(mockPage);
			const newSelector = vi.fn().mockReturnValue(createMockLocator());

			const cloned = pageObj.cloneWithContext(
				newRoot as unknown as Locator,
				newSelector,
			);

			expect(cloned).not.toBe(pageObj);
			expect(cloned.page).toBe(mockPage);
			expect(cloned.root).toBe(newRoot);
		});

		it("$ returns the locator for raw Playwright access", () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				selector,
			);
			expect(pageObj.$).toBe(mockLocator);
		});
	});

	describe("wait methods", () => {
		it("waitVisible calls expect(locator).toBeVisible()", async () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				selector,
			);
			await pageObj.waitVisible();
			expect(mockPlaywrightExpect).toHaveBeenCalledWith(
				mockLocator,
				expect.any(Object),
			);
		});

		it("waitHidden calls expect(locator).toBeHidden()", async () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				selector,
			);
			await pageObj.waitHidden();
			expect(mockPlaywrightExpect).toHaveBeenCalledWith(
				mockLocator,
				expect.any(Object),
			);
		});

		it("waitText calls expect(locator).toHaveText(text)", async () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				selector,
			);
			await pageObj.waitText("hello");
			expect(mockPlaywrightExpect).toHaveBeenCalledWith(
				mockLocator,
				expect.any(Object),
			);
		});

		it("waitValue calls expect(locator).toHaveValue", async () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				selector,
			);
			await pageObj.waitValue(42);
			expect(mockPlaywrightExpect).toHaveBeenCalledWith(
				mockLocator,
				expect.any(Object),
			);
		});

		it("waitNoValue calls expect(locator).not.toHaveAttribute", async () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				selector,
			);
			await pageObj.waitNoValue();
			expect(mockPlaywrightExpect).toHaveBeenCalledWith(
				mockLocator,
				expect.any(Object),
			);
		});

		it("waitCount calls expect(locator).toHaveCount", async () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				selector,
			);
			await pageObj.waitCount(3);
			expect(mockPlaywrightExpect).toHaveBeenCalledWith(
				mockLocator,
				expect.any(Object),
			);
		});

		it("waitChecked calls expect(locator).toBeChecked", async () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				selector,
			);
			await pageObj.waitChecked();
			expect(mockPlaywrightExpect).toHaveBeenCalledWith(
				mockLocator,
				expect.any(Object),
			);
		});

		it("waitUnChecked calls expect(locator).not.toBeChecked", async () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				selector,
			);
			await pageObj.waitUnChecked();
			expect(mockPlaywrightExpect).toHaveBeenCalledWith(
				mockLocator,
				expect.any(Object),
			);
		});

		it("waitProp calls expect with message", async () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				selector,
			);
			await pageObj.waitProp("name", "value");
			expect(mockPlaywrightExpect).toHaveBeenCalledWith(
				mockLocator,
				expect.objectContaining({
					message: "Waiting for prop «name» to be equal to «value»",
				}),
			);
		});

		it("waitPropAbsence calls expect with message", async () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				selector,
			);
			await pageObj.waitPropAbsence("name", "value");
			expect(mockPlaywrightExpect).toHaveBeenCalledWith(
				mockLocator,
				expect.objectContaining({
					message: "Waiting for prop «name» to NOT be equal to «value»",
				}),
			);
		});
	});

	describe("assertions", () => {
		it("expect() returns expect(locator)", () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				selector,
			);
			const result = pageObj.expect();
			expect(mockPlaywrightExpect).toHaveBeenCalledWith(
				mockLocator,
				expect.any(Object),
			);
			expect(result).toBeDefined();
		});

		it("expect({ soft: true }) returns expect.soft(locator)", () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				selector,
			);
			pageObj.expect({ soft: true });
			expect(mockPlaywrightExpectSoft).toHaveBeenCalledWith(
				mockLocator,
				expect.objectContaining({ message: undefined }),
			);
		});

		it("expect({ message: 'x' }) passes message to expect", () => {
			const pageObj = new PageObject(
				mockPage as unknown as Page,
				mockRoot as unknown as Locator,
				selector,
			);
			pageObj.expect({ message: "custom" });
			expect(mockPlaywrightExpect).toHaveBeenCalledWith(
				mockLocator,
				expect.objectContaining({ message: "custom" }),
			);
		});
	});
});
