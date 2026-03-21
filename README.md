# playwright-page-object

Typed, decorator-driven selector composition for Playwright. Keep selectors close to your page objects without forcing a single Page Object Model style.

[![npm version](https://badge.fury.io/js/playwright-page-object.svg)](https://badge.fury.io/js/playwright-page-object)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

## Why This Exists

Playwright locators are powerful, but selector logic often drifts into tests and one-off helpers:

- Selector strings get duplicated.
- Long locator chains hide the UI structure.
- Reusable UI parts turn into ad hoc helpers.
- Moving to a stronger POM often feels like an all-or-nothing rewrite.

`playwright-page-object` gives you a more incremental path:

- Root decorators scope a class to a top-level locator.
- Child decorators resolve relative to that current scope.
- A top-level class can skip root decorators and rely on Playwright **`page`** when body-level scope is enough.
- A **fragment** created from `@Selector("…", Factory)` with `constructor(readonly locator: Locator)` can host its own nested `@Selector*` accessors under **`this.locator`**.
- Accessors can return a raw `Locator`, your own control class, or the built-in `PageObject` classes.
- Selector chains stay lazy and are rebuilt only when accessed.

Use it with the class style you already have:

- plain classes that follow the normal Playwright constructor shape `(page: Page, ...rest)`
- your own controls that accept a `Locator`
- the built-in `RootPageObject`, `PageObject`, and `ListPageObject` classes when you want an out-of-the-box POM layer

## Installation

```bash
npm install -D playwright-page-object
```

Or use `yarn add -D`, `pnpm add -D`, or `bun add -D`.

Requirements:

- Node `>=20`
- `@playwright/test >=1.35.0`
- TypeScript `>=5.0` when you use decorator + `accessor` syntax

This library relies on the ECMAScript `accessor` keyword. Make sure your `tsconfig.json` targets a compatible environment such as `"target": "ES2015"` or higher.

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
	accessor ApplyPromoButton!: ButtonControl;

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

This stays a plain class. The decorators only teach the accessors how to resolve locators.

### Same idea without `@RootSelector`

Skip the root decorator when body-level scope is enough and your `data-testid` values are globally unique. Child decorators still work as long as the instance exposes Playwright **`page`**:

```ts
import type { Locator, Page } from "@playwright/test";
import { Selector, SelectorByRole } from "playwright-page-object";

class ButtonControl {
	constructor(readonly locator: Locator) {}
}

class CheckoutPage {
	constructor(readonly page: Page) {}

	@Selector("PromoCodeInput")
	accessor PromoCodeInput!: Locator;

	@SelectorByRole("button", { name: "Apply" }, ButtonControl)
	accessor ApplyPromoButton!: ButtonControl;
}
```

A fuller version with `PageObject` and lists lives in [example/e2e/page-objects/PlainHostCheckoutPage.ts](example/e2e/page-objects/PlainHostCheckoutPage.ts). That example also wires [PromoSectionFragment](example/e2e/page-objects/PromoSectionFragment.ts) (`readonly locator` + nested `@Selector`) via `@Selector("PromoSection", PromoSectionFragment)`.

### Nested `@Selector*` under `this.locator` (fragment)

When you pass a **class** as the last argument to `@Selector(...)`, the library constructs it with the resolved parent locator. If that class exposes a **Locator-like** **`locator`** property (typical pattern: `constructor(readonly locator: Locator)`), its nested child decorators continue **under that element** instead of falling back to `page`:

```ts
import type { Locator, Page } from "@playwright/test";
import { Selector } from "playwright-page-object";

class PromoSection {
	constructor(readonly locator: Locator) {}

	@Selector("PromoCodeInput")
	accessor PromoInput!: Locator;
}

class CheckoutPage {
	constructor(readonly page: Page) {}

	@Selector("PromoSection", PromoSection)
	accessor promo!: PromoSection;
}
```

## Core Mental Model

### 1. Root decorators establish locator context (optional if you have `page`)

Use `@RootSelector(...)` and its variants on top-level classes when you want a **scoped** container root (for example a section `data-testid`). For plain classes, the first constructor argument must be `page: Page`. If you want the built-in base class for top-level objects, extend `RootPageObject`.

**Without** a root decorator, the same plain class shape still works as long as the instance exposes Playwright **`page`**. In that case child decorators resolve from **`page.locator("body")`** — equivalent to **`@RootSelector()`** (body root), **not** equivalent to **`@RootSelector("SomeTid")`** (narrowed root).

Use `PageObject` for nested controls only. Top-level root-decorated classes should extend `RootPageObject`, not `PageObject`.

### 2. Child decorators resolve relative selectors

Decorators such as `@Selector(...)` and `@SelectorByRole(...)` resolve from the **current context**, in order:

1. If the instance already has a decorator-managed locator context (including `PageObject`, `RootPageObject`, and plain classes decorated with `@RootSelector(...)`), selectors chain from that locator.
2. Otherwise, if the instance has a **Locator-like** **`locator`** property (typical: `constructor(readonly locator: Locator)` on a fragment from a selector factory), selectors chain from **`this.locator`**.
3. Otherwise, if the instance has a Playwright **`page`** property, selectors chain from **`page.locator("body")`**.
4. Otherwise resolution throws (see [Decorator reference](#decorator-reference)).

If both **`locator`** and **`page`** are present, **`locator`** wins (fragment / element scope over body).

Scoped root versus body-only host:

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
page.locator("body").getByTestId("CheckoutPage").getByTestId("PromoCodeInput");
```

A host with **only** `page` and **no** `@RootSelector` behaves like **`@RootSelector()`** + child: for the same accessor, the chain is:

```ts
page.locator("body").getByTestId("PromoCodeInput");
```

Use a **scoped** `@RootSelector("…")` when you rely on a container test id; use a **`page`-only** host when body-level chaining and globally unique ids are enough.

### 3. The accessor value chooses the result shape

The same selector decorators can produce different result shapes:

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

You can drop `@RootSelector("CheckoutPage")` here when body scope and globally unique test ids are enough: same accessors, but the class only declares `constructor(readonly page: Page) {}` and imports `Selector` (no root decorator).

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
	accessor PromoCode!: ExternalInputControl;

	@SelectorByRole("button", { name: "Apply" }, ExternalButtonControl)
	accessor ApplyPromoButton!: ExternalButtonControl;
}
```

### Built-in POM layer

Use this when you want batteries-included helpers like `$`, waits, assertions, and list composition.

```ts
import type { Locator } from "@playwright/test";
import {
	ListPageObject,
	ListSelector,
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

	@ListSelector("CartItem_")
	accessor CartItems = new ListPageObject(CartItemControl);

	@ListSelector("CartItem_")
	accessor CartItemRows!: Locator;
}
```

Give each repeated row a stable prefixed test id in markup (for example `CartItem_${id}`) and use `@ListSelector("CartItem_")` so the regex targets row roots only—not sibling ids such as `CartItemName` or `CartItemPrice`.

These styles can coexist in the same class. The example app includes a root class that mixes all of them:

- `PageObject` accessors for built-in helpers
- raw `Locator` accessors for minimal abstraction (including multi-element lists from `@ListSelector` / `@ListStrictSelector`)
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

Root page objects remain page-first: construct them with `new CheckoutPage(page)`. They are top-level objects only and cannot be nested under another selector.

### `PageObject`

Use `PageObject` for nested controls. It provides:

- raw locator access via `$`
- `page` derived from the current root context via `root.page()`
- Playwright assertions via `.expect()`
- wait helpers such as `.waitVisible()` and `.waitCount()`
- nested control composition through selector decorators

Examples:

```ts
await control.$.click();
await control.expect().toBeVisible();
await cartItems.waitCount(0);
```

Nested `PageObject` subclasses use the default constructor shape `(root?: Locator, selector?: SelectorType)`. If a nested subclass needs custom constructor arguments, implement `cloneWithContext()` so it can rebuild itself with the new `root` and `selector`.

Wait helpers:

| Method | Description |
| --- | --- |
| `.waitVisible()` / `.waitHidden()` | Wait for visibility changes. |
| `.waitText(text)` | Wait for exact text. |
| `.waitValue(value)` / `.waitNoValue()` | Wait for input value changes. |
| `.waitCount(count)` | Wait for the resolved count. |
| `.waitChecked()` / `.waitUnChecked()` | Wait for checkbox or radio state. |
| `.waitProp(name, value)` | Wait for a React or Vue data prop. |
| `.waitPropAbsence(name, value)` | Wait for a React or Vue data prop to stop matching a value. |

Assertions:

| Method | Description |
| --- | --- |
| `.expect()` | Returns a Playwright `expect(locator)` assertion API. |
| `.expect({ soft: true })` | Returns the soft-assertion variant. |
| `.expect({ message: "..." })` | Adds a custom assertion message. |

### `ListPageObject`

Use `ListPageObject` for repeated child controls and collections.

```ts
@ListSelector("CartItem_")
accessor CartItems = new ListPageObject(CartItemControl);
```

Useful APIs:

- `list.items[0]`
- `list.items.at(-1)`
- `for await (const item of list.items) { ... }`
- `await list.count()`
- `await list.getAll()`
- `list.first()`
- `list.second()`
- `list.last()`
- `list.filterByText("Apple")`
- `list.filterByTestId("CartItem_2")`
- `list.filterByText("Apple").first()`
- `list.getItemByText("Apple")`
- `list.getItemByRole("button", { name: "Remove" })`
- `list.getItemByIdMask("CartItem_")`

Helpers such as `first()`, `second()`, `last()`, `at()`, `getItemByText()`, `getItemByRole()`, and `getItemByIdMask()` return a single item page object. Helpers such as `filter()`, `filterByText()`, and `filterByTestId()` return a narrower `ListPageObject`, so chain `.first()` or `.at(...)` when you need one matched item.

### List rows without `ListPageObject`

You can type the accessor as `Locator` with the same list decorator. That yields Playwright’s multi-element locator (use `.nth()`, `.count()`, `expect(locator).toHaveCount()`, etc.):

```ts
@ListSelector("CartItem_")
accessor CartItemRows!: Locator;
```

Prefer row test ids with a **declarative prefix** (`CartItem_1`, `CartItem_2`, …) so `@ListSelector("CartItem_")` stays readable and avoids accidental matches on related ids.

## Fixtures

`createFixtures()` works with classes that can be constructed with only `page: Page`. That includes built-in `RootPageObject` classes, plain classes with `@RootSelector`, and plain classes that rely only on a **`page`** property for child decorators (no root class decorator).

If your page object needs additional constructor arguments, create it in your own fixture instead of passing it directly to `createFixtures()`.

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

When you do not need a container test id, you can omit `@RootSelector("…")` and keep `constructor(readonly page: Page)` only. Tradeoff: selectors are not automatically narrowed to one section; prefer unique `data-testid` values (or add `@RootSelector("…")` later).

### 2. Introduce external controls where repetition appears

When the same locator patterns or UI behavior appear in multiple places, move them into your own control classes that accept a `Locator`.

```ts
@Selector("PromoCodeInput", ExternalInputControl)
accessor PromoCode!: ExternalInputControl;
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

**Context resolution for child decorators:** first use the locator context created by decorators / built-in page objects; otherwise a Locator-like **`locator`** property; otherwise Playwright **`page`** → **`page.locator("body")`**; otherwise an error is thrown when the accessor is read.

Child decorators can return:

- raw `Locator` (including list locators from `@ListSelector` / `@ListStrictSelector`)
- external controls via constructor or factory
- built-in `PageObject` or `ListPageObject`

## AI Ready

This repo ships an [Agent Skills](https://agentskills.io/) compatible skill for assistants that support project-specific guidance.

The skill lives in [skills/playwright-page-object/SKILL.md](skills/playwright-page-object/SKILL.md). It documents the optional **`page`-only** host pattern, **fragment** controls with **`this.locator`**, scoped roots, and the built-in POM types.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

This project is licensed under the [ISC License](LICENSE).
