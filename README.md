# playwright-page-object

`playwright-page-object` is a TypeScript-first Page Object Model framework for Playwright that replaces raw `page.locator()` chains with a typed, composable, decorator-driven control graph.

Every piece of UI becomes a class. Every selector becomes a typed accessor. Every test becomes a readable composition of controls.

## 🧬 Package DNA & Philosophy

- **Everything is a PageObject**: No artificial hierarchy between "pages" and "components". A modal, a button, and a page are all constructed the exact same way.
- **Strongly Typed over Stringly-Typed**: Eliminate raw locator strings in tests completely. Tests only use typed accessors.
- **Composable over flat**: Controls nest inside controls to mirror the actual DOM or component structure.
- **Relative Locators & Reusability**: Because controls nest, locators are chained under the hood (`parent.locator().getByTestId(...)`). Selectors only need to be unique *within their parent component*, massively improving reusability. Instead of `data-testid="checkout-page-cart-item-remove-button"`, you just use `data-testid="Remove"`.
- **Lazy over eager**: Locator chains rebuild dynamically only when accessed, ensuring resilience against dynamic DOM changes and re-renders.
- **Playwright Best Practices Embedded**: Deep support for user-facing attributes (`getByRole`, `getByText`, etc.) natively via decorators, with web-first assertions built-in.

### The Control Graph
Controls compose into a hierarchical structure mirroring the DOM or your components structure:

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
    await checkoutPage.CartItems.items[0].RemoveButton.click();
});
```

## 📦 Installation

```bash
npm install -D playwright-page-object
```

*Note: This library heavily relies on the ECMAScript standard `accessor` keyword (stable in TypeScript 5.0+). Make sure your `tsconfig.json` targets an appropriate environment (`"target": "ES2015"` or higher) or ensures decorators are supported.*

## 📚 Comprehensive API Reference: `PageObject`

When a class extends `PageObject`, it inherits a rich set of built-in methods for actions, waits, and assertions.

### Actions

Like raw Playwright, these actions automatically wait for the element to become actionable (visible, enabled, stable).

| Method | Description |
|--------|-------------|
| `.click(options?)` | Clicks the element. |
| `.dblclick(options?)` | Double-clicks the element. |
| `.hover(options?)` | Hovers over the element. |
| `.fill(value, options?)` | Fills the input with the given value. |
| `.clear(options?)` | Clears the input value. |
| `.check(options?)` | Checks a checkbox or radio button. |
| `.uncheck(options?)` | Unchecks a checkbox. |
| `.press(key, options?)` | Presses a key (e.g., `Enter`, `Tab`) on the element. |

### Waits

| Method | Description |
|--------|-------------|
| `.waitVisible()` | Waits for the element to become visible. |
| `.waitHidden()` | Waits for the element to become hidden. |
| `.waitText(text)` | Waits for the element to have the given text (string or regex). |
| `.waitValue(value)` | Waits for the element to have the given value. |
| `.waitNoValue()` | Waits for the element to have no value. |
| `.waitCount(count)` | Waits for the locator to resolve to the given count. |
| `.waitChecked()` | Waits for a checkbox/radio to be checked. |
| `.waitUnChecked()` | Waits for a checkbox/radio to be unchecked. |
| `.waitProp(name, value)` | Waits for a React/Vue prop (data attribute) to equal the given value. |
| `.waitPropAbsence(name, value)` | Waits for a React/Vue prop (data attribute) to NOT equal the given value. |

### Assertions

Provides native Playwright assertions securely tied to the underlying locator.

| Method | Description |
|--------|-------------|
| `.expect()` | Returns a Playwright expect assertion for this locator (e.g., `await myControl.expect().toBeEnabled()`). |
| `.expect({ soft: true })` | Support for soft assertions that do not fail the test immediately. |

## 📚 Comprehensive API Reference: `ListPageObject`

Manage collections of elements effortlessly with `ListPageObject`.

### The `.items` Proxy

| Feature | Description |
|---------|-------------|
| Array-like access | Access specific items directly via index: `list.items[0]` |
| Async iteration | Iterate over all matching items easily: `for await (const item of list.items) { ... }` |

### Retrieval & Filtering

| Method | Description |
|--------|-------------|
| `.first()` | Returns the first item (index 0). |
| `.last()` | Returns the last item (index -1). |
| `.getItemByIndex(index)` | Returns the item at the given index. |
| `.filter(options)` | Returns items matching the given Playwright filter options. |
| `.filterByText(text)` | Returns items containing the given text. |
| `.filterByTestId(id)` | Returns items that contain an element with the given test id. |
| `.getItemByText(text)` | Returns the specific item containing the given text. |
| `.getItemByRole(role, options?)` | Returns the specific item matching the given ARIA role. |

### Utilities

| Method | Description |
|--------|-------------|
| `.count()` | Returns the total number of items in the list. |
| `.getAll()` | Returns all items as an array of page objects. |

## 🏷️ Decorators Cheat Sheet

The library provides 1-to-1 mappings with Playwright's native locator methods. 
*(Note: Decorators automatically wire up the parent locator and Playwright `page` instance to the controls behind the scenes, keeping your classes clean.)*

Each strategy has a `@Selector...` variant for nested controls and a `@RootSelector...` variant for top-level pages.

### Root Locators (Top-level entry points)

Used on classes to define the base locator for a page or top-level component.

| Decorator | Maps to |
|-----------|---------|
| `@RootSelector(id)` | `getByTestId(id)` |
| `@RootSelectorByRole(role, options?)` | `getByRole(role, options)` |
| `@RootSelectorByText(text, options?)` | `getByText(text, options)` |
| `@RootSelectorByLabel(label, options?)` | `getByLabel(label, options)` |
| `@RootSelectorByPlaceholder(placeholder, options?)` | `getByPlaceholder(placeholder, options)` |
| `@RootSelectorByAltText(altText, options?)` | `getByAltText(altText, options)` |
| `@RootSelectorByTitle(title, options?)` | `getByTitle(title, options)` |

### Child Locators (Nested elements)

Used on properties (`accessor`) inside a `PageObject` to locate children relative to the parent.

| Decorator | Maps to |
|-----------|---------|
| `@Selector(id)` | `getByTestId(id)` |
| `@SelectorByRole(role, options?)` | `getByRole(role, options)` |
| `@SelectorByText(text, options?)` | `getByText(text, options)` |
| `@SelectorByLabel(label, options?)` | `getByLabel(label, options)` |
| `@SelectorByPlaceholder(placeholder, options?)` | `getByPlaceholder(placeholder, options)` |
| `@SelectorByAltText(altText, options?)` | `getByAltText(altText, options)` |
| `@SelectorByTitle(title, options?)` | `getByTitle(title, options)` |
| `@SelectorBy(selectorFunction)` | Custom locator function |

### List Locators

Used for collections of elements.

| Decorator | Maps to |
|-----------|---------|
| `@ListSelector(id)` | `getByTestId(new RegExp(id))` — matches children sharing a test ID pattern |
| `@ListStrictSelector(id)` | `getByTestId(id)` — exact match |
| `@ListRootSelector(id)` | `getByTestId(id)` on the root level |

## 🔄 Incremental Adoption (Brownfield Projects)

Migrating an entire test suite to a new Page Object Model is daunting. `playwright-page-object` is designed so you don't have to rewrite everything at once:

1. **New Features Only**: Continue running your existing tests as-is. Build new pages and controls using the `playwright-page-object` model.
2. **Mix & Match Fixtures**: You can register `playwright-page-object` fixtures using `createFixtures` alongside your existing Playwright fixtures without any conflicts.
3. **Escape Hatch**: The internal Playwright locator is kept `protected` by design. If you need to integrate a newly created control with legacy functions that expect raw `Locator` objects, you can easily expose it via a getter in your subclass.

## 🚀 Step-by-Step Usage Guide

### Step 1: Create Base Controls
A component or basic control extending the core `PageObject`.

```typescript
import { PageObject, SelectorByRole } from "playwright-page-object";

export class ButtonControl extends PageObject {
    // You can add specific behaviors or complex actions for buttons here
}

export class CartItemControl extends PageObject {
    @SelectorByRole("button", { name: "Remove" }) 
    accessor RemoveButton = new ButtonControl();
}
```

### Step 2: Compose a Page
Compose components inside a root page using `@RootSelector` variants. Remember to use the `accessor` keyword!

```typescript
import { PageObject, RootSelector, Selector, ListSelector, ListPageObject } from "playwright-page-object";
import { ButtonControl, CartItemControl } from "./controls";

@RootSelector("CheckoutPage") // matches data-testid="CheckoutPage"
export class CheckoutPage extends PageObject {
    // A single element
    @Selector("PromoCodeInput") 
    accessor PromoCode = new PageObject();

    @Selector("ApplyPromoButton") 
    accessor ApplyPromoButton = new ButtonControl();

    // A list of nested elements
    @ListSelector("CartItem") 
    accessor CartItems = new ListPageObject(CartItemControl);
}
```

### Step 3: Register Fixtures
You can seamlessly inject your root page objects into Playwright tests using the `createFixtures` helper. This automatically instantiates your page objects and provides them with the Playwright `page` instance.

```typescript
import { test as base } from "@playwright/test";
import { createFixtures } from "playwright-page-object";
import { CheckoutPage } from "./CheckoutPage";

// Extend Playwright's test instance with your Root Page Objects
export const test = base.extend(createFixtures({
    checkoutPage: CheckoutPage,
}));
```

### Step 4: Write the Test
Enjoy fully typed, resilient tests with clear actions, assertions, and list handling.

```typescript
import { test } from "./fixtures";

test("should apply promo code and remove first item", async ({ checkoutPage }) => {
    // Fill the promo code
    await checkoutPage.PromoCode.fill("SAVE20");
    await checkoutPage.ApplyPromoButton.click();

    // The items proxy allows array-like access, fully typed!
    const firstItem = checkoutPage.CartItems.items[0];
    await firstItem.RemoveButton.click();
    
    // Assertions are built-in
    await checkoutPage.CartItems.waitCount(0);

    // Iterating over items asynchronously
    for await (const item of checkoutPage.CartItems.items) {
        await item.expect({ soft: true }).toBeVisible();
    }
});
```

## 🤖 AI Ready

This package is available in [Context7](https://context7.com) MCP, so AI assistants can load it directly into context when working with your Playwright tests.

It also ships an [Agent Skills](https://agentskills.io) – compatible skill. Install it so your AI assistant loads playwright-page-object guidance:

```bash
npx ctx7 skills install /sergeyshmakov/playwright-page-object playwright-page-object
```

The skill lives in [skills/playwright-page-object/SKILL.md](skills/playwright-page-object/SKILL.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute to this project.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
