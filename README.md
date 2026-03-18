# playwright-page-object

Decorator-driven Playwright selector composition for plain classes, external controls, and optional `PageObject` base classes.

[![npm version](https://badge.fury.io/js/playwright-page-object.svg)](https://badge.fury.io/js/playwright-page-object)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

## Why This Exists

Raw Playwright locator chains are powerful, but they tend to spread selector logic across tests:

- Locator strings get duplicated.
- Relative structure gets flattened into long chains.
- UI parts that should be reusable stay as ad hoc helpers.
- Incrementally moving to stronger abstractions usually means rewriting everything at once.

`playwright-page-object` solves that with decorators and typed accessors:

- Root decorators bind a class instance to a top-level locator.
- Child decorators resolve locators relative to that root.
- Accessors can return a raw `Locator`, your own control class, or the built-in `PageObject` classes.
- Selector chains stay lazy and are rebuilt only when accessed.

The library is class-instance agnostic. You can use it with:

- plain classes that follow the normal Playwright constructor shape `(page: Page, ...rest)`
- your own controls that accept a `Locator`
- the built-in `RootPageObject`, `PageObject`, and `ListPageObject` classes when you want an out-of-the-box POM layer

## Installation

```bash
npm install -D playwright-page-object
```

Or use `yarn add -D`, `pnpm add -D`, or `bun add -D`.

This library relies on the ECMAScript `accessor` keyword, available in TypeScript 5.0+. Make sure your `tsconfig.json` targets a compatible environment such as `"target": "ES2015"` or higher.

## Quick Start

You do not need to extend the built-in `PageObject` classes to start using the decorators.

```ts
import type { Locator, Page } from "@playwright/test";
import { RootSelector, Selector, SelectorByRole } from "playwright-page-object";

class ButtonControl {
	constructor(readonly locator: Locator) {}
}

@RootSelector("CheckoutPage")
class CheckoutPage {
	constructor(readonly page: Page) {}

	@Selector("PromoCodeInput")
	accessor PromoCodeInput!: Locator;

	@SelectorByRole("button", { name: "Apply" }, ButtonControl)
	accessor ApplyPromoButton = undefined as unknown as ButtonControl;

	async applyPromoCode(code: string) {
		await this.PromoCodeInput.fill(code);
		await this.ApplyPromoButton.locator.click();
	}
}
```

```ts
import { test } from "@playwright/test";

test("apply promo code", async ({ page }) => {
	const checkout = new CheckoutPage(page);
	await checkout.applyPromoCode("SAVE20");
});
```

## Core Mental Model

### 1. Root decorators establish locator context

Use `@RootSelector(...)` and its variants on top-level classes. For plain classes, the first constructor argument must be `page: Page`. If you want to use the built-in root base class, extend `RootPageObject`.

Do not use `@RootSelector(...)` on classes that extend `PageObject` directly. `PageObject` is for nested controls, not root classes.

### 2. Child decorators resolve relative selectors

Decorators such as `@Selector(...)` and `@SelectorByRole(...)` resolve from the root context created by the root decorator.

That means this:

```ts
@RootSelector("CheckoutPage")
class CheckoutPage {
	constructor(readonly page: Page) {}

	@Selector("PromoCodeInput")
	accessor PromoCodeInput!: Locator;
}
```

behaves like:

```ts
page.getByTestId("CheckoutPage").getByTestId("PromoCodeInput");
```

but stays typed, reusable, and class-friendly.

### 3. The accessor value chooses the result shape

The same selector decorators can produce different kinds of results:

- `Locator`: declare the accessor as `Locator`
- external control: pass a constructor or factory as the last decorator argument
- built-in `PageObject` or `ListPageObject`: initialize the accessor with those classes

## Choose Your Output Style

### Locator-first

Use this when you want decorators now without adopting another base class or abstraction layer yet.

```ts
import type { Locator, Page } from "@playwright/test";
import { RootSelector, Selector } from "playwright-page-object";

@RootSelector("CheckoutPage")
class CheckoutPage {
	constructor(readonly page: Page) {}

	@Selector("PromoCodeInput")
	accessor PromoCodeInput!: Locator;
}
```

Usage:

```ts
await checkoutPage.PromoCodeInput.fill("SAVE20");
```

### External controls

Use this when you already have your own controls or want reusable abstractions without inheriting from the built-in `PageObject` classes.

```ts
import type { Locator, Page } from "@playwright/test";
import { RootSelector, Selector, SelectorByRole } from "playwright-page-object";

class ExternalInputControl {
	constructor(readonly locator: Locator) {}

	fill(value: string) {
		return this.locator.fill(value);
	}
}

class ExternalButtonControl {
	constructor(readonly locator: Locator) {}
}

@RootSelector("CheckoutPage")
class ExternalCheckoutPage {
	constructor(readonly page: Page) {}

	@Selector("PromoCodeInput", ExternalInputControl)
	accessor PromoCode = undefined as unknown as ExternalInputControl;

	@SelectorByRole("button", { name: "Apply" }, ExternalButtonControl)
	accessor ApplyPromoButton = undefined as unknown as ExternalButtonControl;
}
```

### Built-in POM layer

Use this when you want batteries-included helpers like `$`, waits, assertions, and list composition.

```ts
import {
	ListPageObject,
	ListStrictSelector,
	PageObject,
	RootPageObject,
	RootSelector,
	Selector,
	SelectorByRole,
} from "playwright-page-object";

class ButtonControl extends PageObject {}

class CartItemControl extends PageObject {
	@SelectorByRole("button", { name: "Remove" })
	accessor RemoveButton = new ButtonControl();
}

@RootSelector("CheckoutPage")
class CheckoutPage extends RootPageObject {
	@Selector("PromoCodeInput")
	accessor PromoCode = new PageObject();

	@SelectorByRole("button", { name: "Apply" })
	accessor ApplyPromoButton = new ButtonControl();

	@ListStrictSelector("CartItem")
	accessor CartItems = new ListPageObject(CartItemControl);
}
```

These styles can coexist in the same class. The example app includes a root class that mixes all of them:

- `PageObject` accessors for built-in helpers
- raw `Locator` accessors for minimal abstraction
- typed controls for reusable UI elements
- `ListPageObject` for collections

## Built-In `PageObject` Layer

The built-in base classes are optional convenience layers on top of the same decorator system.

### `RootPageObject`

Use `RootPageObject` for root-decorated classes that are created directly from Playwright `Page`.

```ts
@RootSelector("CheckoutPage")
class CheckoutPage extends RootPageObject {}
```

### `PageObject`

Use `PageObject` for nested controls. It provides:

- raw locator access via `$`
- Playwright assertions via `.expect()`
- wait helpers such as `.waitVisible()` and `.waitCount()`
- nested control composition through selector decorators

Examples:

```ts
await control.$.click();
await control.expect().toBeVisible();
await cartItems.waitCount(0);
```

Wait helpers:

| Method | Description |
| --- | --- |
| `.waitVisible()` / `.waitHidden()` | Wait for visibility changes. |
| `.waitText(text)` | Wait for exact text. |
| `.waitValue(value)` / `.waitNoValue()` | Wait for input value changes. |
| `.waitCount(count)` | Wait for the resolved count. |
| `.waitChecked()` / `.waitUnChecked()` | Wait for checkbox or radio state. |
| `.waitProp(name, value)` | Wait for a React or Vue data prop. |

Assertions:

| Method | Description |
| --- | --- |
| `.expect()` | Returns a Playwright `expect(locator)` assertion API. |
| `.expect({ soft: true })` | Returns the soft-assertion variant. |

### `ListPageObject`

Use `ListPageObject` for repeated child controls and collections.

```ts
@ListStrictSelector("CartItem")
accessor CartItems = new ListPageObject(CartItemControl);
```

Useful APIs:

- `list.items[0]`
- `list.items.at(-1)`
- `for await (const item of list.items) { ... }`
- `await list.count()`
- `await list.first()`
- `await list.filterByText("Apple")`

## Fixtures

`createFixtures()` works with any root class whose first constructor argument is `page: Page`. That includes both built-in `RootPageObject` classes and plain decorated classes.

```ts
import { test as base } from "@playwright/test";
import { createFixtures } from "playwright-page-object";
import { CheckoutPage } from "./page-objects/CheckoutPage";
import { ExternalCheckoutPage } from "./page-objects/ExternalCheckoutPage";

export const test = base.extend<{
	checkoutPage: CheckoutPage;
	externalCheckoutPage: ExternalCheckoutPage;
}>(
	createFixtures({
		checkoutPage: CheckoutPage,
		externalCheckoutPage: ExternalCheckoutPage,
	}),
);
```

## Incremental Adoption

You do not need to migrate your whole suite to a new inheritance model in one go.

### 1. Start locator-first

Decorate existing page classes and keep accessors as raw `Locator`.

```ts
@RootSelector("CheckoutPage")
class CheckoutPage {
	constructor(readonly page: Page) {}

	@Selector("PromoCodeInput")
	accessor PromoCodeInput!: Locator;
}
```

### 2. Introduce external controls where repetition appears

When the same locator patterns or UI behavior appear in multiple places, move them into your own control classes that accept a `Locator`.

```ts
@Selector("PromoCodeInput", ExternalInputControl)
accessor PromoCode = undefined as unknown as ExternalInputControl;
```

### 3. Adopt the built-in POM layer where it helps

Switch specific areas to `RootPageObject`, `PageObject`, and `ListPageObject` when you want built-in assertions, waits, `$`, or list helpers.

```ts
@RootSelector("CheckoutPage")
class CheckoutPage extends RootPageObject {
	@Selector("PromoCodeInput")
	accessor PromoCode = new PageObject();
}
```

You can mix all three approaches in the same codebase, fixture setup, and even the same root class.

## Decorator Reference

### Root decorators

| Decorator | Playwright mapping |
| --- | --- |
| `@RootSelector(id)` | `getByTestId(id)` |
| `@RootSelector()` | root is `page.locator("body")` |
| `@ListRootSelector(id)` | `getByTestId(new RegExp(id))` |
| `@RootSelectorByRole(...)` | `getByRole(...)` |
| `@RootSelectorByText(text)` | `getByText(text)` |
| `@RootSelectorByLabel(...)` | `getByLabel(...)` |
| `@RootSelectorByPlaceholder(...)` | `getByPlaceholder(...)` |
| `@RootSelectorByAltText(...)` | `getByAltText(...)` |
| `@RootSelectorByTitle(...)` | `getByTitle(...)` |

### Child decorators

| Decorator | Playwright mapping |
| --- | --- |
| `@Selector(id)` | `getByTestId(id)` |
| `@Selector()` | identity selector |
| `@ListSelector(id)` | `getByTestId(new RegExp(id))` |
| `@ListStrictSelector(id)` | `getByTestId(id)` |
| `@SelectorByRole(...)` | `getByRole(...)` |
| `@SelectorByText(text)` | `getByText(text)` |
| `@SelectorByLabel(...)` | `getByLabel(...)` |
| `@SelectorByPlaceholder(...)` | `getByPlaceholder(...)` |
| `@SelectorByAltText(...)` | `getByAltText(...)` |
| `@SelectorByTitle(...)` | `getByTitle(...)` |
| `@SelectorBy(fn)` | custom locator logic |

Child decorators can return:

- raw `Locator`
- external controls via constructor or factory
- built-in `PageObject` or `ListPageObject`

## AI Ready

This package is available in [Context7](https://context7.com/) MCP, so AI assistants can load it directly into context when working with your Playwright tests.

It also ships an [Agent Skills](https://agentskills.io/) compatible skill:

```bash
npx ctx7 skills install /sergeyshmakov/playwright-page-object playwright-page-object
```

The skill lives in [skills/playwright-page-object/SKILL.md](skills/playwright-page-object/SKILL.md).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

This project is licensed under the [ISC License](LICENSE).
