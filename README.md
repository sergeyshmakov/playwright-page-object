# playwright-page-object

A TypeScript-first Page Object Model framework for Playwright that replaces raw `page.locator()` chains with a typed, composable, decorator-driven control graph.

[![npm version](https://badge.fury.io/js/playwright-page-object.svg)](https://badge.fury.io/js/playwright-page-object)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

## ⚠️ The Problem

When writing end-to-end tests with Playwright, we often rely on raw locator chains (e.g., `page.locator('.cart').getByTestId('remove-btn')`). This approach becomes difficult to maintain as your application grows:

- **Stringly-Typed Locators:** Raw strings offer no IDE autocomplete. Typos in locators or test IDs go unnoticed until tests run.
- **Fragile Tests:** Minor DOM changes break multiple tests across your suite because locator logic is duplicated everywhere.
- **Flat Structure:** UI is inherently a nested tree of components, but raw locators are often flat and difficult to compose or reuse.
- **Boilerplate:** Manually creating Page Objects often involves writing tedious getter methods and constructor passing for every single element.

## 🚀 The Solution

`playwright-page-object` solves this by introducing a **Control Graph**. Every piece of UI becomes a class, every selector becomes a typed accessor, and controls nest inside controls to mirror the actual DOM.

It completely eliminates raw locator strings in tests, giving you 100% type safety, reusable relative locators, and clean, readable test code.

```typescript
import { PageObject, SelectorByRole, RootSelector, Selector, ListSelector, ListPageObject } from "playwright-page-object";
import { test } from "./fixtures";

// Define your controls once
class ButtonControl extends PageObject {}

class CartItemControl extends PageObject {
    @SelectorByRole("button", { name: "Remove" }) 
    accessor RemoveButton = new ButtonControl();
}

@RootSelector("CheckoutPage")
class CheckoutPage extends PageObject {
    @Selector("PromoCodeInput") 
    accessor PromoCode = new PageObject();

    @ListSelector("CartItem") 
    accessor CartItems = new ListPageObject(CartItemControl);
}

// Write readable, typed tests without any raw locator strings
test("remove first cart item", async ({ checkoutPage }) => {
    // Locator chains are lazily evaluated:
    // "page.getByTestId('CheckoutPage').getByTestId(/CartItem/).nth(0).getByRole('button', { name: 'Remove' })"
    await checkoutPage.CartItems.items[0].RemoveButton.$.click();
});
```

## 📦 Installation

```bash
npm install -D playwright-page-object
```

*(or use `yarn add -D playwright-page-object`, `pnpm add -D playwright-page-object`, `bun add -D playwright-page-object`)*

*Note: This library heavily relies on the ECMAScript standard `accessor` keyword (stable in TypeScript 5.0+). Make sure your `tsconfig.json` targets an appropriate environment (`"target": "ES2015"` or higher).*

## 🤖 AI Ready

This package is available in [Context7](https://context7.com/) MCP, so AI assistants can load it directly into context when working with your Playwright tests.

It also ships an [Agent Skills](https://agentskills.io/) – compatible skill. Install it so your AI assistant loads playwright-page-object guidance:

```bash
npx ctx7 skills install /sergeyshmakov/playwright-page-object playwright-page-object
```

The skill lives in [skills/playwright-page-object/SKILL.md](skills/playwright-page-object/SKILL.md).

## 💡 Philosophy

- **Everything is a PageObject:** A modal, a button, and a page are all constructed the exact same way.
- **Strongly Typed:** Eliminate raw locator strings in tests. Your IDE guides you through the component tree.
- **Composable:** Controls nest inside controls to mirror the actual DOM. Locators are chained under the hood, maximizing reusability.
- **Lazy Evaluation:** Locator chains rebuild dynamically only when accessed, ensuring resilience against DOM changes and re-renders.
- **Playwright Best Practices:** Native web-first assertions, direct raw locator access via `$`, and user-facing attribute selection (`getByRole`, `getByText`) via decorators.

## 📚 Core API

### `PageObject`

When a class extends `PageObject`, it inherits wait helpers, assertions, and raw locator access.

#### Raw Locator (`$`)

Use `control.$` for Playwright actions. Keeps the library version-agnostic — any Playwright API is available.

```typescript
await control.$.click();
await control.$.fill("text");
await control.$.hover();
```

#### Waits

| Method | Description |
|---|---|
| `.waitVisible()` / `.waitHidden()` | Waits for the element visibility. |
| `.waitText(text)` | Waits for the element to have the given text. |
| `.waitValue(value)` / `.waitNoValue()` | Waits for the element to have/not have a value. |
| `.waitCount(count)` | Waits for the locator to resolve to the given count. |
| `.waitChecked()` / `.waitUnChecked()` | Waits for a checkbox/radio state. |
| `.waitProp(name, value)` | Waits for a React/Vue prop to equal value. |

#### Assertions

| Method | Description |
|---|---|
| `.expect()` | Returns a Playwright expect assertion (e.g., `await myControl.expect().toBeEnabled()`). |
| `.expect({ soft: true })` | Support for soft assertions that do not fail the test immediately. |

### `ListPageObject`

Manage collections of elements effortlessly.

#### The `.items` Proxy

- **Array-like access:** Access specific items directly via index: `list.items[0]`, `list.items.at(-1)`
- **Async iteration:** Iterate over all matching items easily: `for await (const item of list.items) { ... }`

#### Retrieval & Filtering

| Method | Description |
|---|---|
| `.first()` / `.last()` / `.at(i)` | Returns item at specific index. |
| `.filter(options)` | Returns items matching Playwright filter options. |
| `.filterByText(text)` | Returns items containing the given text. |
| `.filterByTestId(id)` | Returns items that contain an element with the given test id. |
| `.getItemByText(text)` / `.getItemByRole(...)` | Returns the specific item matching criteria. |
| `.count()` / `.getAll()` | Returns total count or array of all items. |

### 🏷️ Decorators Cheatsheet

Decorators automatically wire up the parent locator and Playwright `page` instance to the controls behind the scenes.

| Strategy | Root (Top-level pages) | Child (Nested elements) | Maps to Playwright API |
|---|---|---|---|
| **Test ID** | `@RootSelector(id)` | `@Selector(id)` | `getByTestId(id)` |
| **Role** | `@RootSelectorByRole(role)` | `@SelectorByRole(role)` | `getByRole(role)` |
| **Text** | `@RootSelectorByText(text)` | `@SelectorByText(text)` | `getByText(text)` |
| **Label** | `@RootSelectorByLabel(label)` | `@SelectorByLabel(label)` | `getByLabel(label)` |
| **Placeholder** | `@RootSelectorByPlaceholder(placeholder)` | `@SelectorByPlaceholder(placeholder)` | `getByPlaceholder(placeholder)` |
| **Custom** | - | `@SelectorBy(fn)` | Custom locator function |

**List Decorators** (used with `ListPageObject`):
- `@ListSelector(id)`: `getByTestId(new RegExp(id))` (matches children sharing a test ID pattern)
- `@ListStrictSelector(id)`: `getByTestId(id)` (exact match)
- `@ListRootSelector(id)`: `getByTestId(id)` on the root level

## 🔄 Incremental Adoption

Migrating an entire test suite to a new Page Object Model is daunting. `playwright-page-object` is designed so you don't have to rewrite everything at once:

1. **New Features Only:** Continue running your existing tests as-is. Build new pages and controls using the new model.
2. **Mix & Match Fixtures:** You can register `playwright-page-object` fixtures using `createFixtures` alongside your existing Playwright fixtures without conflicts.
3. **Easy integration:** Use `control.$` to pass the raw locator to legacy code expecting `Locator`.

### Adoption Approaches

**Approach 1: Locator-first (incremental)**  
Use child accessors as `Locator` when you can't instantiate `PageObject` yet. Define the selector and use the locator directly in tests.

```typescript
@RootSelector("CheckoutPage")
class CheckoutPage extends PageObject {
    @Selector("PromoCodeInput")
    accessor PromoCode!: Locator;  // use as locator: checkoutPage.PromoCode.fill("SAVE20")
}
```

**Approach 2: Page-object-first (recommended)**  
Start with `accessor ChildControl = new PageObject()` from day one. In tests, use `ChildControl.$` for actions.

```typescript
@RootSelector("CheckoutPage")
class CheckoutPage extends PageObject {
    @Selector("PromoCodeInput")
    accessor PromoCode = new PageObject(); // use in tests: await checkoutPage.PromoCode.$.fill("SAVE20")
}
```

## 📖 Step-by-Step Guide

### 1. Create Base Controls

A component or basic control extending the core `PageObject`.

```typescript
import { PageObject, SelectorByRole } from "playwright-page-object";

export class ButtonControl extends PageObject {}

export class CartItemControl extends PageObject {
    @SelectorByRole("button", { name: "Remove" }) 
    accessor RemoveButton = new ButtonControl();
}
```

### 2. Compose a Page

Compose components inside a root page using `@RootSelector` variants. Remember to use the `accessor` keyword!

```typescript
import { PageObject, RootSelector, Selector, ListSelector, ListPageObject } from "playwright-page-object";
import { ButtonControl, CartItemControl } from "./controls";

@RootSelector("CheckoutPage") // matches data-testid="CheckoutPage"
export class CheckoutPage extends PageObject {
    @Selector("PromoCodeInput") 
    accessor PromoCode = new PageObject();

    @Selector("ApplyPromoButton") 
    accessor ApplyPromoButton = new ButtonControl();

    @ListSelector("CartItem") 
    accessor CartItems = new ListPageObject(CartItemControl);
}
```

### 3. Register Fixtures

Inject your root page objects into Playwright tests using the `createFixtures` helper.

```typescript
import { test as base } from "@playwright/test";
import { createFixtures } from "playwright-page-object";
import { CheckoutPage } from "./CheckoutPage";

export const test = base.extend<{ checkoutPage: CheckoutPage }>(
    createFixtures({ checkoutPage: CheckoutPage }),
);
```

### 4. Write the Test

Enjoy fully typed, resilient tests with clear actions, assertions, and list handling.

```typescript
import { test } from "./fixtures";

test("should apply promo code and remove first item", async ({ checkoutPage }) => {
    // 1. Actions via raw locator ($)
    await checkoutPage.PromoCode.$.fill("SAVE20");
    await checkoutPage.ApplyPromoButton.$.click();

    // 2. The items proxy allows array-like access
    const firstItem = checkoutPage.CartItems.items[0];
    await firstItem.RemoveButton.$.click();
    
    // 3. Built-in assertions and waits
    await checkoutPage.CartItems.waitCount(0);

    // 4. Async iteration
    for await (const item of checkoutPage.CartItems.items) {
        await item.expect({ soft: true }).toBeVisible();
    }
});
```

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for more details.

## 📄 License

This project is licensed under the [ISC License](LICENSE).
