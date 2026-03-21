---
name: playwright-page-object
version: 1.3.0
description: >
  Decorator-driven Playwright selector composition for plain classes, external
  controls, and optional RootPageObject/PageObject/ListPageObject usage. Use
  when the user mentions @RootSelector, @Selector, createFixtures, page-only
  hosts with readonly page, fragments with readonly locator, list selectors, or
  incremental migration from raw Playwright locators to typed page objects.
---

# playwright-page-object

## Use This Skill For

- choosing between plain classes, external controls, and built-in page objects
- explaining root/context resolution for decorator-based selectors
- wiring Playwright fixtures with `createFixtures()`
- migrating from raw locator chains without forcing a full POM rewrite

## Core Model

- Treat this library as a locator-composition layer, not a mandatory inheritance framework.
- Root decorators scope a top-level class.
- Child decorators resolve from the nearest available context.
- The accessor shape chooses the return type:
  - raw `Locator`
  - external control via constructor or factory
  - built-in `PageObject`
  - built-in `ListPageObject`

## Context Resolution

Child decorators resolve in this order:

1. decorator-managed locator context (`LOCATOR_SYMBOL`, including `PageObject`, `RootPageObject`, and plain classes decorated with `@RootSelector(...)`)
2. Locator-like `locator` property
3. Playwright `page` -> `page.locator("body")`
4. otherwise error when the accessor is read

Important:

- a page-only host behaves like `@RootSelector()`, not `@RootSelector("SomeTid")`
- if both `locator` and `page` exist, `locator` wins
- `@Selector()` is the identity selector from the current root
- `@RootSelector()` uses `page.locator("body")` as the root

## Valid Host Styles

- plain scoped root: plain class + `@RootSelector(...)`, constructor first arg `page: Page`
- page-only host: plain class with `readonly page: Page`, no root decorator, body-level scope only
- fragment: class with `readonly locator: Locator`, usually created via `@Selector("...", FragmentClass)`
- built-in root: class extends `RootPageObject` and uses root decorators

## Hard Rules

- Use `accessor` on decorated child members.
- Never put `@RootSelector(...)` on a class that extends `PageObject` directly.
- Use `RootPageObject` for top-level root classes only.
- Use `PageObject` for nested controls only.
- If a nested `PageObject` subclass has a custom constructor, implement `cloneWithContext()`.
- `createFixtures()` only works for classes constructible as `new X(page)`. If extra args are needed, write a custom fixture.
- Prefer preserving the user's current style. Do not force migration to the built-in POM unless the user asks for it.

## Choosing a Style

### Plain class + decorators

Use when:

- the user already has ordinary Playwright page classes
- incremental adoption matters
- the user wants typed selectors without library inheritance

Pattern:

```ts
@RootSelector("CheckoutPage")
class CheckoutPage {
	constructor(readonly page: Page) {}

	@Selector("PromoCodeInput")
	accessor PromoCodeInput!: Locator;
}
```

### Page-only host

Use when:

- body-level scope is enough
- test ids are globally unique
- the user wants the lightest possible setup

Pattern:

```ts
class CheckoutPage {
	constructor(readonly page: Page) {}

	@Selector("PromoCodeInput")
	accessor PromoCodeInput!: Locator;
}
```

### Fragment with `this.locator`

Use when:

- a subtree should become a reusable nested control
- the fragment needs its own child `@Selector*` accessors

Pattern:

```ts
class PromoSection {
	constructor(readonly locator: Locator) {}

	@Selector("PromoCodeInput")
	accessor PromoInput!: Locator;
}
```

### External controls

Use when:

- the codebase already has classes that accept a `Locator`
- the user wants typed controls without extending `PageObject`

Patterns:

```ts
@Selector("PromoCodeInput", ExternalInputControl)
accessor PromoCode!: ExternalInputControl;
```

```ts
@SelectorByRole("button", { name: "Apply" }, ExternalButtonControl)
accessor ApplyPromoButton!: ExternalButtonControl;
```

### Built-in POM

Use when:

- the user wants `$`, waits, and `.expect()`
- the codebase already leans on built-in page-object helpers
- the agent is creating a new built-in POM from scratch

Rules:

- `RootPageObject` is the correct root base class
- nested actions usually go through `control.$`
- nested `PageObject` instances derive `page` from `root.page()`

### Lists

Use `ListPageObject` when the user needs:

- `items[0]`
- async iteration
- `count()`
- filtering or item lookup helpers

Use raw `Locator` with `@ListSelector(...)` / `@ListStrictSelector(...)` when the user wants plain Playwright operations such as `.nth()` and `.count()`.

Prefer prefixed row ids such as `CartItem_${id}` with `@ListSelector("CartItem_")` so list roots do not collide with child ids like `CartItemName`.

Helper semantics:

- `first()`, `second()`, `last()`, `at()`, `getItemByText()`, `getItemByRole()`, `getItemByIdMask()` -> one item
- `filter()`, `filterByText()`, `filterByTestId()` -> narrower `ListPageObject`

## Fixtures

Prefer `createFixtures(...)` when the user wants fixture wiring, but do not require it.

Valid:

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

`createFixtures()` supports:

- `RootPageObject` roots
- plain classes with `@RootSelector(...)`
- page-only hosts with `readonly page: Page`

It does not supply extra constructor arguments.

## Recommended Adoption Path

Unless the user asks for a full built-in POM, prefer:

1. locator-first accessors
2. external controls where repetition appears
3. built-in `RootPageObject` / `PageObject` / `ListPageObject` only where their helpers add value

These styles can coexist in one codebase and even in one root class.

## Read More Only If Needed

For detailed docs or concrete patterns, read these files instead of inventing a new style:

- [README.md](README.md)
- [example/e2e/page-objects/CheckoutPage.ts](example/e2e/page-objects/CheckoutPage.ts)
- [example/e2e/page-objects/ExternalCheckoutPage.ts](example/e2e/page-objects/ExternalCheckoutPage.ts)
- [example/e2e/page-objects/PlainHostCheckoutPage.ts](example/e2e/page-objects/PlainHostCheckoutPage.ts)
- [example/e2e/page-objects/PromoSectionFragment.ts](example/e2e/page-objects/PromoSectionFragment.ts)
- [example/e2e/fixtures.ts](example/e2e/fixtures.ts)
- [src/tests/decorators/selectors-page-fallback.spec.ts](src/tests/decorators/selectors-page-fallback.spec.ts)
- [src/tests/page-objects/PageObject.advanced.spec.ts](src/tests/page-objects/PageObject.advanced.spec.ts)
