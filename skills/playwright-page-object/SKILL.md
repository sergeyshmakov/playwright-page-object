---
name: playwright-page-object
version: 1.0.0
description: >
  TypeScript-first, decorator-driven Page Object Model for Playwright. Replaces
  raw page.locator() chains with composable, typed PageObject classes. Use this
  skill whenever the user is writing Playwright tests, refactoring existing tests
  to use page objects, setting up test fixtures, or working with Playwright
  locators—even if they don't mention "page object" or "POM". Also trigger for:
  createFixtures, @RootSelector, @Selector, @ListSelector, ListPageObject,
  control graph, decorator POM, typed locators, nested components in tests.
---

## Core Philosophy & Architecture

- **Everything is a `PageObject`**: No artificial hierarchy between "pages" and "components". A modal, a button, and a page are all constructed the exact same way.
- **Strongly Typed over Stringly-Typed**: Eliminate raw locator strings in tests completely. Tests only use typed accessors.
- **Composable & Relative**: Controls nest inside controls to mirror the DOM. Selectors only need to be unique *within their parent component*, massively improving reusability.
- **Lazy Evaluation**: Locator chains rebuild dynamically only when accessed, ensuring resilience against dynamic DOM changes and re-renders.

## Critical Rules for AI Agents

1. **Accessor keyword**: Use the `accessor` keyword with every child property decorator (e.g., `@Selector("id") accessor MyControl = new PageObject();`). TC39 decorators require `accessor` for class fields; without it, decorators fail or behave incorrectly.

2. **Assertion placement**: Keep assertions (`expect()`) in test files, not inside `PageObject` classes. Assertions belong in tests so failures surface at the right level and page objects stay reusable across different expectations.

3. **Actions via `$`**: Use `control.$.click()`, `control.$.fill()`, etc. for Playwright actions. The `$` getter exposes the raw locator—any Playwright API is available without library updates.

4. **Instantiation**: Use `createFixtures` to wire pages into tests. `createFixtures` wires the Playwright `page` into page objects and ensures proper lifecycle; manual `new MyPage(page)` bypasses that.

## Setup & Requirements

- **Install**: `npm install -D playwright-page-object`
- **TypeScript Configuration**: Requires TypeScript 5.0+. Because this framework uses modern TC39 standard decorators, you must configure `tsconfig.json` appropriately:
  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "experimentalDecorators": false
    }
  }
  ```
  *(Note: `experimentalDecorators` must be `false` or omitted to ensure the standard TC39 implementation is used.)*

## Step-by-Step Implementation Pattern

### 1. Define Controls (Leaf Nodes)
```typescript
import { PageObject, SelectorByRole } from "playwright-page-object";

export class ButtonControl extends PageObject {}

export class CartItemControl extends PageObject {
    @SelectorByRole("button", { name: "Remove" })
    accessor RemoveButton = new ButtonControl();
}
```

### 2. Compose the Root Page
```typescript
import { PageObject, RootSelector, Selector, ListSelector, ListPageObject } from "playwright-page-object";
import { ButtonControl, CartItemControl } from "./controls";

@RootSelector("CheckoutPage") // Matches data-testid="CheckoutPage"
export class CheckoutPage extends PageObject {
    @Selector("PromoCodeInput")
    accessor PromoCode = new PageObject();

    @Selector("ApplyPromoButton")
    accessor ApplyPromoButton = new ButtonControl();

    @ListSelector("CartItem") // Matches data-testid(/CartItem/)
    accessor CartItems = new ListPageObject(CartItemControl);
}
```

### 3. Register Fixtures
```typescript
import { test as base } from "@playwright/test";
import { createFixtures } from "playwright-page-object";
import { CheckoutPage } from "./CheckoutPage";

export const test = base.extend(createFixtures({
    checkoutPage: CheckoutPage,
}));
```

### 4. Write Typed Tests
```typescript
import { test } from "./fixtures";

test("apply promo and remove first item", async ({ checkoutPage }) => {
    await checkoutPage.PromoCode.$.fill("SAVE20");
    await checkoutPage.ApplyPromoButton.$.click();

    // Array-like access via .items proxy
    await checkoutPage.CartItems.items[0].RemoveButton.$.click();
    await checkoutPage.CartItems.waitCount(0);
});
```

## Decorator Reference

### Root Selectors (Class-level, Top-level Pages)
| Decorator | Playwright Equivalent |
|-----------|-----------------------|
| `@RootSelector(id)` | `getByTestId(id)` |
| `@RootSelectorByRole(role, opts?)` | `getByRole(role, opts)` |
| `@RootSelectorByText(text, opts?)` | `getByText(text, opts)` |
| `@RootSelectorByLabel(label, opts?)` | `getByLabel(label, opts)` |
| `@RootSelectorByPlaceholder(ph, opts?)`| `getByPlaceholder(ph, opts)` |
| `@RootSelectorByAltText(alt, opts?)` | `getByAltText(alt, opts)` |
| `@RootSelectorByTitle(title, opts?)` | `getByTitle(title, opts)` |

### Child Selectors (Accessor-level, Nested Elements)
| Decorator | Playwright Equivalent |
|-----------|-----------------------|
| `@Selector(id)` | `parent.getByTestId(id)` |
| `@SelectorByRole(role, opts?)` | `parent.getByRole(role, opts)` |
| `@SelectorByText(text, opts?)` | `parent.getByText(text, opts)` |
| `@SelectorByLabel(label, opts?)` | `parent.getByLabel(label, opts)` |
| `@SelectorByPlaceholder(ph, opts?)`| `parent.getByPlaceholder(ph, opts)` |
| `@SelectorByAltText(alt, opts?)` | `parent.getByAltText(alt, opts)` |
| `@SelectorByTitle(title, opts?)` | `parent.getByTitle(title, opts)` |
| `@SelectorBy(fn)` | Custom locator function |

### List Selectors
| Decorator | Playwright Equivalent / Behavior |
|-----------|----------------------------------|
| `@ListSelector(id)` | `getByTestId(new RegExp(id))` — fuzzy match pattern |
| `@ListStrictSelector(id)`| `getByTestId(id)` — exact match |
| `@ListRootSelector(id)` | Root-level list lookup |

## API Reference

### `PageObject` Built-in API
- **Raw locator** `control.$` — use for Playwright actions: `control.$.click()`, `control.$.fill()`, etc.
- **Waits**: `.waitVisible()`, `.waitHidden()`, `.waitText(text)`, `.waitValue(value)`, `.waitNoValue()`, `.waitCount(n)`, `.waitChecked()`, `.waitUnChecked()`, `.waitProp(name, value)`, `.waitPropAbsence(name, value)`
- **Assertions**:
  ```typescript
  await myControl.expect().toBeEnabled();
  await myControl.expect({ soft: true }).toBeVisible();
  ```

### `ListPageObject` API
- **Access & Iteration**:
  - `list.items[n]` (Array-like access proxy)
  - `for await (const item of list.items)` (Async iteration)
- **Retrieval**: `.first()`, `.last()`, `.getItemByIndex(n)`, `.getItemByText("foo")`, `.getItemByRole("button", { name: "foo" })`, `.getAll()`
- **Filtering**: `.filter({ hasText: "foo" })`, `.filterByText("foo")`, `.filterByTestId("bar")`
- **Utility**: `.count()`

## Incremental Adoption (Brownfield)
Use `control.$` to pass the raw locator to legacy code expecting `Locator`. No subclassing needed. `createFixtures` can be safely mixed with existing Playwright fixtures without conflicts.
