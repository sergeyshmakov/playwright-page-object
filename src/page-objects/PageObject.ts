import { expect, type Locator, type Page } from "@playwright/test";
import { prop } from "../utils/helpers";

/**
 * Function type that derives a {@link Locator} from a root locator.
 * Used by decorators to resolve element selectors within a page object.
 */
export type SelectorType = (p: Locator) => Locator;

/**
 * Constructor signature for PageObject subclasses.
 * Accepts `page`, `root`, and `selector` for composition and nesting.
 */
export type PageObjectConstructor<TPageObject extends PageObject = PageObject> =
	new (
		page?: Page,
		root?: Locator,
		selector?: SelectorType,
	) => TPageObject;

/**
 * Base class for the Page Object Model pattern with Playwright.
 *
 * Extend this class and use decorators (`RootSelector`, `Selector`, etc.) to define
 * the root locator and child elements. Provides wait helpers, assertions via `expect()`,
 * and raw locator access via `$` for Playwright actions.
 *
 * @example
 * ```ts
 * @RootSelector("app-header")
 * class HeaderPageObject extends PageObject {
 *   @SelectorByText("Sign in") signInButton = this.locator;
 * }
 * ```
 */
export class PageObject {
	page?: Page;
	root?: Locator;

	/**
	 * @param page - Playwright page (optional when nested)
	 * @param root - Root locator (set by decorators)
	 * @param selector - Selector function (set by decorators)
	 */
	constructor(page?: Page, root?: Locator, selector?: SelectorType) {
		this.page = page;
		this.root = root;
		this._selector = selector;
	}

	private _selector?: SelectorType;

	protected get selector(): SelectorType | undefined {
		return this._selector;
	}

	protected set selector(selector: SelectorType | undefined) {
		this._selector = selector;
	}

	/**
	 * Resolved locator for this page object.
	 * Throws if `RootSelector` or `Selector` decorators were not applied.
	 */
	protected get locator(): Locator {
		if (!this.selector) {
			throw new Error(
				`[PageObject] Empty selector in ${this.constructor.name}. Maybe "RootSelector" or "Selector" was skipped?`,
			);
		}
		if (!this.root) {
			throw new Error(
				`[PageObject] Empty root in ${this.constructor.name}. Maybe "RootSelector" was skipped?`,
			);
		}
		return this.selector(this.root);
	}

	/**
	 * Raw Playwright locator. Use for actions: `control.$.click()`, `control.$.fill()`, etc.
	 * Keeps the library version-agnostic—any Playwright API is available via `$`.
	 */
	get $(): Locator {
		return this.locator;
	}

	/**
	 * Type guard: checks if a value is a PageObject class (constructor).
	 *
	 * @param value - Value to check
	 * @returns `true` if value is a PageObject subclass constructor
	 */
	static isClass<TArgs extends unknown[]>(
		value?: unknown,
	): value is new (
		...args: TArgs
	) => PageObject {
		return typeof value === "function" && value.prototype instanceof PageObject;
	}

	/**
	 * Type guard: checks if a value is a PageObject instance.
	 *
	 * @param value - Value to check
	 * @returns `true` if value is a PageObject instance
	 */
	static isInstance(value?: unknown): value is PageObject {
		return value instanceof PageObject;
	}

	/**
	 * Creates a new instance with a different root and selector (used for nesting).
	 * **Required override** when extending PageObject with a custom constructor.
	 *
	 * @param root - New root locator
	 * @param selector - New selector function
	 * @returns New instance of this class with the given context
	 */
	cloneWithContext(root: Locator, selector: SelectorType): this {
		const PageObjectClass = this.constructor as PageObjectConstructor<this>;
		return new PageObjectClass(root.page(), root, selector);
	}

	/** Waits for the element to become visible. */
	async waitVisible() {
		await this.expect().toBeVisible();
	}

	/** Waits for the element to become hidden. */
	async waitHidden() {
		await this.expect().toBeHidden();
	}

	/**
	 * Waits for the element to have the given text.
	 * @param text - Expected text (string or regex)
	 */
	async waitText(text: string) {
		await this.expect().toHaveText(text);
	}

	/**
	 * Waits for the element to have the given value.
	 * @param value - Expected value (string or number)
	 */
	async waitValue(value: string | number) {
		await this.expect().toHaveValue(String(value));
	}

	/** Waits for the element to have no value. */
	async waitNoValue() {
		await this.expect().not.toHaveAttribute(prop("$value"));
	}

	/**
	 * Waits for the locator to resolve to the given count.
	 * @param count - Expected number of matching elements
	 */
	async waitCount(count: number) {
		await this.expect().toHaveCount(count);
	}

	/** Waits for a checkbox/radio to be checked. */
	async waitChecked() {
		await this.expect().toBeChecked();
	}

	/** Waits for a checkbox/radio to be unchecked. */
	async waitUnChecked() {
		await this.expect().not.toBeChecked();
	}

	/**
	 * Waits for a React/Vue prop (data attribute) to equal the given value.
	 * **Prefer user-visible assertions**; use sparingly for internal component state.
	 *
	 * @param name - Prop name (e.g. `disabled`)
	 * @param value - Expected value
	 */
	async waitProp(name: string, value: string) {
		await this.expect({
			message: `Waiting for prop «${name}» to be equal to «${value}»`,
		}).toHaveAttribute(prop(name), value);
	}

	/**
	 * Waits for a React/Vue prop (data attribute) to NOT equal the given value.
	 * **Prefer user-visible assertions**; use sparingly for internal component state.
	 *
	 * @param name - Prop name (e.g. `disabled`)
	 * @param value - Value that must not be present
	 */
	async waitPropAbsence(name: string, value: string) {
		await this.expect({
			message: `Waiting for prop «${name}» to NOT be equal to «${value}»`,
		}).not.toHaveAttribute(prop(name), value);
	}

	/** ASSERTIONS */

	/**
	 * Returns a Playwright expect assertion for this locator.
	 *
	 * @param options - Optional `message` and `soft` (for soft assertions)
	 * @returns Playwright expect API for this locator
	 */
	expect(options?: {
		message?: string;
		soft?: boolean;
	}): ReturnType<typeof expect<Locator>> {
		if (!this.locator)
			throw new Error('Can\'t call "expect" with empty "locator"');

		return options?.soft
			? expect.soft(this.locator, { message: options?.message })
			: expect(this.locator, { message: options?.message });
	}
}
