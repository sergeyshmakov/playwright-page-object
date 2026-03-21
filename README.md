# playwright-page-object

Typed, decorator-driven selector composition for Playwright. Keep selectors close to your page objects without forcing a single Page Object Model style.

[![npm version](https://badge.fury.io/js/playwright-page-object.svg)](https://badge.fury.io/js/playwright-page-object)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

## Problem

Playwright locators are powerful, but selector logic often leaks into tests:

- Selector strings get duplicated across files
- Long locator chains obscure the actual UI structure
- Reusable UI parts become scattered ad-hoc helpers
- Adopting a structured Page Object Model feels like an all-or-nothing rewrite

## Solution

`playwright-page-object` provides an incremental path forward:

- **Root decorators** scope a class to a top-level locator
- **Child decorators** resolve selectors relative to that scope
- **Lazy chains** rebuild only when accessed
- **Multiple output styles** support your existing patterns

Use it with plain classes, custom controls, or built-in `PageObject` helpers—no breaking changes required.

## Installation

```bash
npm install -D playwright-page-object
```

**Requirements:**
- Node `>=20`
- `@playwright/test >=1.35.0`
- TypeScript `>=5.0` (when using decorators + accessors)

Ensure your `tsconfig.json` targets `"ES2015"` or higher for ECMAScript accessor support.

## Quick Start

No need to extend built-in classes—start with plain classes:

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

### Using page-only hosts (no root decorator)

Skip `@RootSelector` when your `data-testid` values are globally unique:

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

See [PlainHostCheckoutPage.ts](example/e2e/page-objects/PlainHostCheckoutPage.ts) and [PromoSectionFragment.ts](example/e2e/page-objects/PromoSectionFragment.ts) for a fuller example.

### Composing fragments with `@Selector` + `this.locator`

Pass a class to `@Selector(...)` to create reusable fragments. If that class exposes a `locator` property, nested decorators chain under that element:

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

## How It Works

### Root decorators set locator scope

**Scoped root** — establishes a container-level context:

```ts
@RootSelector("CheckoutPage")
class CheckoutPage {
	constructor(readonly page: Page) {}

	@Selector("PromoCodeInput")
	accessor PromoCodeInput!: Locator;
}

// Resolves to: page.locator("body").getByTestId("CheckoutPage").getByTestId("PromoCodeInput")
```

**Page-only host** — chains from body without a scoped container:

```ts
class CheckoutPage {
	constructor(readonly page: Page) {}

	@Selector("PromoCodeInput")
	accessor PromoCodeInput!: Locator;
}

// Resolves to: page.locator("body").getByTestId("PromoCodeInput")
```

Use a scoped root when relying on a container test id; use page-only when globally unique ids suffice.

### Child decorators resolve from context

Child decorators resolve in this order:

1. Decorator-managed locator context (from `@RootSelector`, `PageObject`, etc.)
2. `Locator`-like `locator` property (fragments)
3. Playwright `page` property → `page.locator("body")`
4. Error if none match

If both `locator` and `page` exist, `locator` wins (element scope > page scope).

### Accessor type determines output shape

- `Locator` — raw Playwright locator
- **Custom class** — decorator passes resolved locator to that constructor
- `PageObject` / `ListPageObject` — use built-in helpers

## Output Styles

### 1. Raw Locator (minimal abstraction)

```ts
@RootSelector("CheckoutPage")
class CheckoutPage {
	constructor(readonly page: Page) {}

	@Selector("PromoCodeInput")
	accessor PromoCodeInput!: Locator;
}

await checkoutPage.PromoCodeInput.fill("SAVE20");
```

Drop `@RootSelector` if body scope suffices.

### 2. Custom Controls (reusable abstractions)

```ts
class ExternalInputControl {
	constructor(readonly locator: Locator) {}
	fill(value: string) {
		return this.locator.fill(value);
	}
}

@RootSelector("CheckoutPage")
class CheckoutPage {
	constructor(readonly page: Page) {}

	@Selector("PromoCodeInput", ExternalInputControl)
	accessor PromoCode!: ExternalInputControl;
}

await checkoutPage.PromoCode.fill("SAVE20");
```

### 3. Built-in POM Layer (batteries included)

```ts
import {
	ListPageObject,
	ListSelector,
	PageObject,
	RootPageObject,
	RootSelector,
	Selector,
	SelectorByRole,
} from "playwright-page-object";

class CartItemControl extends PageObject {
	@SelectorByRole("button", { name: "Remove" })
	accessor RemoveButton = new PageObject();
}

@RootSelector("CheckoutPage")
class CheckoutPage extends RootPageObject {
	@Selector("PromoCodeInput")
	accessor PromoCode = new PageObject();

	@SelectorByRole("button", { name: "Apply" })
	accessor ApplyPromoButton = new PageObject();

	@ListSelector("CartItem_")
	accessor CartItems = new ListPageObject(CartItemControl);
}

await checkoutPage.PromoCode.$.fill("SAVE20");
await checkoutPage.expect().toBeVisible();
await checkoutPage.CartItems.waitCount(3);
```

Styles coexist in the same class—mix as needed.

## Built-In Classes

### `RootPageObject`

Use for root-decorated classes instantiated directly from `page`:

```ts
@RootSelector("CheckoutPage")
class CheckoutPage extends RootPageObject {}

const checkout = new CheckoutPage(page);
```

### `PageObject`

Use for nested controls. Provides:

| Feature | Example |
|---------|---------|
| Raw locator | `await control.$.click()` |
| Assertions | `await control.expect().toBeVisible()` |
| Wait helpers | `await control.waitVisible()` |
| Page access | `control.page()` |

**Wait methods:**

| Method | Purpose |
|--------|---------|
| `.waitVisible()` / `.waitHidden()` | Wait for visibility |
| `.waitText(text)` | Wait for exact text |
| `.waitValue(value)` / `.waitNoValue()` | Wait for input value |
| `.waitCount(count)` | Wait for element count |
| `.waitChecked()` / `.waitUnChecked()` | Wait for checkbox state |
| `.waitProp(name, value)` | Wait for React/Vue data prop |
| `.waitPropAbsence(name)` | Wait for data prop absence |

**Assertion methods:**

```ts
await control.expect().toBeVisible();
await control.expect({ soft: true }).toHaveText("Click me");
await control.expect({ message: "Button is enabled" }).toBeEnabled();
```

### `ListPageObject`

Use for repeated child controls:

```ts
@ListSelector("CartItem_")
accessor CartItems = new ListPageObject(CartItemControl);
```

**Common APIs:**

```ts
list.items[0]                          // First item
list.items.at(-1)                      // Last item
for await (const item of list.items) {} // Iterate
await list.count()                     // Item count
list.first()                           // First item (PageObject)
list.last()                            // Last item (PageObject)
list.filterByText("Apple")             // Narrow by text
list.getItemByText("Apple")            // Get one item by text
list.getItemByRole("button", { name: "Remove" })
```

**For Locator-based lists** (multi-element without helpers):

```ts
@ListSelector("CartItem_")
accessor CartItemRows!: Locator;

// Use: cartPage.CartItemRows.nth(0), expect().toHaveCount()
```

Prefer declarative row ids (`CartItem_1`, `CartItem_2`) to keep selectors readable.

## Fixtures

`createFixtures()` works with classes constructible via `new Class(page)`:

```ts
import { test as base } from "@playwright/test";
import { createFixtures } from "playwright-page-object";
import { CheckoutPage } from "./page-objects/CheckoutPage";

export const test = base.extend<{ checkoutPage: CheckoutPage }>(
	createFixtures({
		checkoutPage: CheckoutPage,
	}),
);
```

For classes with custom constructor arguments, create them in your own fixture.

## Decorator Reference

### Root Decorators

| Decorator | Playwright API |
|-----------|----------------|
| `@RootSelector(id)` | `getByTestId(id)` |
| `@RootSelector()` | `page.locator("body")` |
| `@ListRootSelector(id)` | `getByTestId(new RegExp(id))` |
| `@RootSelectorByRole(...)` | `getByRole(...)` |
| `@RootSelectorByText(text)` | `getByText(text)` |
| `@RootSelectorByLabel(...)` | `getByLabel(...)` |
| `@RootSelectorByPlaceholder(...)` | `getByPlaceholder(...)` |
| `@RootSelectorByAltText(...)` | `getByAltText(...)` |
| `@RootSelectorByTitle(...)` | `getByTitle(...)` |

### Child Decorators

| Decorator | Playwright API |
|-----------|----------------|
| `@Selector(id)` | `getByTestId(id)` |
| `@Selector()` | Identity (no chaining) |
| `@ListSelector(id)` | `getByTestId(new RegExp(id))` |
| `@ListStrictSelector(id)` | `getByTestId(id)` (strict) |
| `@SelectorByRole(...)` | `getByRole(...)` |
| `@SelectorByText(text)` | `getByText(text)` |
| `@SelectorByLabel(...)` | `getByLabel(...)` |
| `@SelectorByPlaceholder(...)` | `getByPlaceholder(...)` |
| `@SelectorByAltText(...)` | `getByAltText(...)` |
| `@SelectorByTitle(...)` | `getByTitle(...)` |
| `@SelectorBy(fn)` | Custom locator logic |

Each can return raw `Locator`, custom controls, `PageObject`, or `ListPageObject`.

## Incremental Adoption

### Step 1: Add decorators, keep Locator output

```ts
@RootSelector("CheckoutPage")
class CheckoutPage {
	constructor(readonly page: Page) {}

	@Selector("PromoCodeInput")
	accessor PromoCodeInput!: Locator;
}
```

### Step 2: Extract reusable controls

```ts
@Selector("PromoCodeInput", ExternalInputControl)
accessor PromoCode!: ExternalInputControl;
```

### Step 3: Adopt PageObject where helpful

```ts
class CheckoutPage extends RootPageObject {
	@Selector("PromoCodeInput")
	accessor PromoCode = new PageObject();
}
```

Mix all three approaches in the same suite.

## AI & Assistant Support

This package is available in [Context7](https://context7.com/) MCP, so AI assistants can load it directly into context when working with your object property paths.

A [Cubic wiki](https://www.cubic.dev/wikis/sergeyshmakov/playwright-page-object) provides AI-ready documentation for this project.

It also ships an [Agent Skills](https://agentskills.io/) – compatible skill. Install it so your AI assistant loads data-path guidance:

```bash
npx ctx7 skills install /sergeyshmakov/playwright-page-object playwright-page-object
```

The skill lives in [skills/playwright-page-object/SKILL.md](skills/playwright-page-object/SKILL.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## License

[ISC License](LICENSE)