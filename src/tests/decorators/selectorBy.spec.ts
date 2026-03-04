import { beforeEach, describe, expect, it, vi } from "vitest";
import { SelectorBy } from "../../decorators/selectorBy";
import { PageObject } from "../../page-objects/PageObject";
import { createMockLocator, createMockPage } from "../mocks/playwright";

describe("SelectorBy", () => {
	let mockPage: ReturnType<typeof createMockPage>;
	let mockRoot: ReturnType<typeof createMockLocator>;
	let mockLocator: ReturnType<typeof createMockLocator>;
	let selectorFn: (root: unknown, value: unknown) => unknown;

	beforeEach(() => {
		mockPage = createMockPage();
		mockRoot = createMockLocator(mockPage as any);
		mockLocator = createMockLocator(mockPage as any);
		mockRoot.page = vi.fn().mockReturnValue(mockPage);
		selectorFn = vi.fn().mockImplementation((root, value) => value);
	});

	it("wraps accessor getter and calls selector with root and value", () => {
		const selector = (root: unknown, value: unknown) => {
			selectorFn(root, value);
			return value;
		};

		class TestPageObject extends PageObject {
			@SelectorBy(selector)
			accessor child = "childValue";
		}

		const rootSelector = vi.fn().mockReturnValue(mockLocator);
		const instance = new TestPageObject(
			mockPage as any,
			mockRoot as any,
			rootSelector as any,
		);

		const result = instance.child;

		expect(selectorFn).toHaveBeenCalledWith(mockLocator, "childValue");
		expect(result).toBe("childValue");
	});

	it("uses parent's locator as root", () => {
		const parentLocator = createMockLocator(mockPage as any);
		const selector = vi
			.fn()
			.mockImplementation((root: unknown, value: unknown) => value);

		class TestPageObject extends PageObject {
			@SelectorBy(selector)
			accessor child = "value";
		}

		const rootSelector = vi.fn().mockReturnValue(parentLocator);
		const instance = new TestPageObject(
			mockPage as any,
			mockRoot as any,
			rootSelector as any,
		);

		instance.child;

		expect(selector).toHaveBeenCalledWith(parentLocator, "value");
	});

	it("throws when used on non-accessor", () => {
		const selector = (root: unknown, value: unknown) => value;
		const decorator = SelectorBy(selector);

		const target = {
			get: vi.fn(),
			set: vi.fn(),
		};
		const context = {
			kind: "field",
			name: "test",
			access: { get: true, set: true },
			metadata: {},
			addInitializer: vi.fn(),
			static: false,
			private: false,
		};

		expect(() => decorator(target as any, context as any)).toThrow(
			/[SelectorBy].*can be used only with accessor.*field/,
		);
	});

	it("preserves selector return type for Locator value", () => {
		const returnedLocator = createMockLocator();
		const selector = vi.fn().mockReturnValue(returnedLocator);

		class TestPageObject extends PageObject {
			@SelectorBy(selector)
			accessor child = createMockLocator();
		}

		const rootSelector = vi.fn().mockReturnValue(mockLocator);
		const instance = new TestPageObject(
			mockPage as any,
			mockRoot as any,
			rootSelector as any,
		);

		const result = instance.child;

		expect(result).toBe(returnedLocator);
	});

	it("preserves selector return type for PageObject value", () => {
		class ChildPageObject extends PageObject {}
		const childInstance = new ChildPageObject(
			mockPage as any,
			mockRoot as any,
			vi.fn() as any,
		);
		const clonedChild = new ChildPageObject(
			mockPage as any,
			mockRoot as any,
			vi.fn() as any,
		);

		const selector = vi.fn().mockReturnValue(clonedChild);

		class TestPageObject extends PageObject {
			@SelectorBy(selector)
			accessor child = childInstance;
		}

		const rootSelector = vi.fn().mockReturnValue(mockLocator);
		const instance = new TestPageObject(
			mockPage as any,
			mockRoot as any,
			rootSelector as any,
		);

		const result = instance.child;

		expect(result).toBe(clonedChild);
		expect(PageObject.isInstance(result)).toBe(true);
	});
});
