---
name: playwright-page-object
version: 1.0.0
description: >
  Decorator-driven Playwright selector composition for plain classes, external
  controls, and optional built-in RootPageObject/PageObject/ListPageObject
  classes. Use when the user mentions @RootSelector, @Selector,
  createFixtures, Playwright page objects, typed locators, nested controls,
  external controls, incremental adoption, or refactoring existing Playwright
  tests to use decorator-based selectors.
---

# playwright-page-object

## Core Model

Treat this library as a decorator-driven locator composition layer, not as a mandatory inheritance framework.

- Root decorators establish locator context for a top-level class.
- Child decorators resolve relative selectors from that context.
- The accessor shape determines the result:
  - raw `Locator`
  - external control created from a constructor or factory
  - built-in `PageObject`
  - built-in `ListPageObject`

Both of these are valid root styles:

- plain class with constructor `(page: Page, ...rest)`
- class extending `RootPageObject`

`PageObject` is for nested controls, not for root classes decorated with `@RootSelector(...)`.

## Agent Detection Checklist

When entering a codebase, detect these first:

1. Root style:
   - plain decorated class with `page: Page` first
   - built-in root extending `RootPageObject`
2. Child output style:
   - `Locator`
   - external control via trailing constructor or factory
   - `PageObject`
   - `ListPageObject`
3. Instantiation style:
   - `createFixtures(...)`
   - manual `new MyPage(page)`
4. Custom nested `PageObject` constructors:
   - the default nested `PageObject` constructor shape is `(root?: Locator, selector?: SelectorType)`
   - if a nested `PageObject` subclass does not use that shape, it must implement `cloneWithContext()`

Preserve the user's current style. Do not force a migration to the built-in POM if the codebase already uses plain classes or external controls successfully.

## Universal Rules

These rules apply to both plain-class and built-in-POM usage:

1. Use `accessor` on every child decorator target.
2. Use a root decorator before child decorators. Child decorators need root context.
3. `@RootSelector()` means root is `page.locator("body")`.
4. `@Selector()` means identity selector from the current root.
5. `createFixtures()` is optional convenience, not a requirement.
6. Decorated accessors are lazy and resolve on access.
7. Keep child selectors relative to the nearest component root.

Hard constraints:

- Never put `@RootSelector(...)` on a class that extends `PageObject` directly.
- Use `RootPageObject` only for top-level root classes.
- Use `PageObject` for nested controls.
- For plain decorated root classes, the first constructor argument must be `page: Page`.

## Decision Rules

### Choose a plain decorated root class when

- the user already has standard Playwright classes
- the user wants typed selectors without adopting library inheritance
- the user has their own control classes that accept `Locator`
- incremental adoption matters more than framework consistency

Pattern:

```ts
@RootSelector("CheckoutPage")
class CheckoutPage {
	constructor(readonly page: Page) {}
}
```

### Choose `RootPageObject` when

- the user wants an out-of-the-box root base class
- the codebase already uses built-in `PageObject` helpers consistently
- the agent is creating a new built-in POM from scratch

Pattern:

```ts
@RootSelector("CheckoutPage")
class CheckoutPage extends RootPageObject {}
```

### Choose `PageObject` when

- a nested control should expose `$`
- the user wants built-in waits or `.expect()`
- the control is reused compositionally under selector decorators

Nested `PageObject` instances derive `page` from their current root context. If a nested `PageObject` subclass adds a custom constructor, either keep the default `(root?: Locator, selector?: SelectorType)` shape or implement `cloneWithContext()` explicitly.

### Choose `ListPageObject` when

- a selector resolves to repeated child controls
- the user needs `items[0]`, async iteration, filtering, or count helpers

### Choose external controls when

- the codebase already has classes that accept a `Locator`
- the user wants typed controls without extending `PageObject`
- constructor or factory output is clearer than a built-in page-object wrapper

Patterns:

```ts
@Selector("PromoCodeInput", ExternalInputControl)
accessor PromoCode!: ExternalInputControl;
```

```ts
@SelectorByRole("button", { name: "Apply" }, (locator) => new ExternalButtonControl(locator))
accessor ApplyPromoButton!: ExternalButtonControl;
```

## Recommended Examples

### Plain root + locator/external control

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
}
```

### Built-in root + built-in nested controls

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

	@ListStrictSelector("CartItem")
	accessor CartItems = new ListPageObject(CartItemControl);
}
```

## Built-In POM Rules

When using the built-in classes:

- actions go through `control.$`
- nested `PageObject` instances derive `page` from `root.page()`
- waits and assertions come from `PageObject`
- `ListPageObject` handles repeated child components
- `ListPageObject` indexing/search helpers such as `first()`, `second()`, `at()`, and `getItemByText()` return one item page object
- `ListPageObject` filter helpers such as `filter()`, `filterByText()`, and `filterByTestId()` return a narrower `ListPageObject`, so chain `.first()` or `.at(...)` when one item is needed
- `RootPageObject` is the correct root base class

Examples:

```ts
await control.$.click();
await control.expect().toBeVisible();
await items.waitCount(0);
await items.filterByText("Apple").first().expect().toBeVisible();
```

## Fixtures

Prefer `createFixtures(...)` when the user wants Playwright fixture wiring, but do not require it.

Both of these are valid:

```ts
const checkout = new CheckoutPage(page);
```

```ts
export const test = base.extend(
	createFixtures({
		checkoutPage: CheckoutPage,
	}),
);
```

`createFixtures()` works with any root constructor whose first argument is `page: Page`.

## Incremental Adoption

Recommend this ladder unless the user asks for a full built-in POM:

1. Locator-first:
   - decorate existing classes
   - return raw `Locator` from child accessors
2. External controls:
   - replace repeated locator patterns with user-owned control classes
3. Built-in POM where helpful:
   - adopt `RootPageObject`, `PageObject`, and `ListPageObject` only in areas that benefit from `$`, waits, assertions, and list helpers

These styles can coexist in one codebase, one fixture map, and even one root class.

## References

Reuse these project examples instead of inventing a new pattern:

- [README.md](README.md)
- [example/e2e/page-objects/ExternalCheckoutPage.ts](example/e2e/page-objects/ExternalCheckoutPage.ts)
- [example/e2e/page-objects/CheckoutPage.ts](example/e2e/page-objects/CheckoutPage.ts)
- [example/e2e/fixtures.ts](example/e2e/fixtures.ts)
- [src/tests/decorators/selectors-external.spec.ts](src/tests/decorators/selectors-external.spec.ts)
- [src/tests/page-objects/PageObject.advanced.spec.ts](src/tests/page-objects/PageObject.advanced.spec.ts)
