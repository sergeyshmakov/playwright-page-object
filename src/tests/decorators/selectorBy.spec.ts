import type { Locator } from "@playwright/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SelectorBy } from "../../decorators/selectorBy";
import { PageObject, type SelectorType } from "../../page-objects/PageObject";
import { createMockLocator, createMockPage } from "../mocks/playwright";

describe("SelectorBy", () => {
	let mockPage: ReturnType<typeof createMockPage>;
	let mockRoot: ReturnType<typeof createMockLocator>;
	let mockLocator: ReturnType<typeof createMockLocator>;
	let selectorFn: (root: unknown, value: unknown) => unknown;

	beforeEach(() => {
		mockPage = createMockPage();
		mockRoot = createMockLocator(mockPage);
		mockLocator = createMockLocator(mockPage);
		mockRoot.page = vi.fn().mockReturnValue(mockPage);
		selectorFn = vi.fn().mockImplementation((_root, value) => value);
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
			mockRoot as unknown as Locator,
			rootSelector as unknown as SelectorType,
		);

		const result = instance.child;

		expect(selectorFn).toHaveBeenCalledWith(mockLocator, "childValue");
		expect(result).toBe("childValue");
	});

	it("uses parent's locator as root", () => {
		const parentLocator = createMockLocator(mockPage);
		const selector = vi
			.fn()
			.mockImplementation((_root: unknown, value: unknown) => value);

		class TestPageObject extends PageObject {
			@SelectorBy(selector)
			accessor child = "value";
		}

		const rootSelector = vi.fn().mockReturnValue(parentLocator);
		const instance = new TestPageObject(
			mockRoot as unknown as Locator,
			rootSelector as unknown as SelectorType,
		);

		instance.child;

		expect(selector).toHaveBeenCalledWith(parentLocator, "value");
	});

	it("throws when used on non-accessor", () => {
		const selector = (_root: unknown, value: unknown) => value;
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

		expect(() =>
			decorator(
				target as unknown as Parameters<typeof decorator>[0],
				context as unknown as Parameters<typeof decorator>[1],
			),
		).toThrow(/[SelectorBy].*can be used only with accessor.*field/);
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
			mockRoot as unknown as Locator,
			rootSelector as unknown as SelectorType,
		);

		const result = instance.child;

		expect(result).toBe(returnedLocator);
	});

	it("preserves selector return type for PageObject value", () => {
		class ChildPageObject extends PageObject {}
		const childInstance = new ChildPageObject(
			mockRoot as unknown as Locator,
			vi.fn() as unknown as SelectorType,
		);
		const clonedChild = new ChildPageObject(
			mockRoot as unknown as Locator,
			vi.fn() as unknown as SelectorType,
		);

		const selector = vi.fn().mockReturnValue(clonedChild);

		class TestPageObject extends PageObject {
			@SelectorBy(selector)
			accessor child = childInstance;
		}

		const rootSelector = vi.fn().mockReturnValue(mockLocator);
		const instance = new TestPageObject(
			mockRoot as unknown as Locator,
			rootSelector as unknown as SelectorType,
		);

		const result = instance.child;

		expect(result).toBe(clonedChild);
		expect(PageObject.isInstance(result)).toBe(true);
	});
});
