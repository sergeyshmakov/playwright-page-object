---
name: playwright-page-object
version: 1.4.0
description: >
  Decorator-driven Playwright selector composition for plain classes, fragments,
  external controls, and optional PageObject/ListPageObject helpers. Use when
  the user needs typed selectors, incremental POM adoption, fixture setup, or
  clarification on context resolution (@RootSelector, @Selector, createFixtures).
---

# playwright-page-object Agent Skill

## Quick Reference

**This library is a locator-composition layer**, not a framework requiring inheritance. Root decorators establish scope; child decorators resolve from context. The accessor type determines output: raw `Locator`, custom control, `PageObject`, or `ListPageObject`.

## When to Use This Skill

- User is adding typed, decorator-driven selectors to Playwright tests
- User needs guidance on plain class vs. POM vs. fragment vs. external control setup
- User is migrating from raw locator chains without forcing a full rewrite
- User wants fixture wiring via `createFixtures()`
- User is unclear on context resolution or decorator scope

## Context Resolution Priority

Child decorators resolve in this order:

1. **Decorator-managed context** — classes with `@RootSelector(...)`, `RootPageObject`, or plain decorated roots
2. **Locator-like `locator` property** — fragments pass context to children
3. **Page property** — `page.locator("body")` fallback
4. **Error** — if none match and accessor is accessed

**Key facts:**
- `locator` property takes precedence over `page` property
- `@Selector()` (no args) is the identity selector—no chaining
- `@RootSelector()` (no args) uses body scope, same as page-only hosts
- Page-only hosts behave like `@RootSelector()`, not container-scoped

## Host Patterns

| Pattern | Root Decorator | First Constructor Arg | Scope |
|---------|---|---|---|
| **Scoped root** | `@RootSelector("TID")` | `page: Page` | Container `TID` |
| **Page-only host** | None | `page: Page` | `page.locator("body")` |
| **Fragment** | None | `locator: Locator` | Chained from parent |
| **Built-in root** | `@RootSelector(...)` + extends `RootPageObject` | `page: Page` | Container, with helpers |

## Accessor Output Types

```ts
// Raw Locator
@Selector("Promo")
accessor PromoInput!: Locator;

// Custom control (must accept Locator in constructor)
@Selector("Promo", MyInputControl)
accessor PromoInput!: MyInputControl;

// PageObject (built-in, nested)
@Selector("Promo")
accessor PromoInput = new PageObject();

// ListPageObject (built-in, repeated items)
@ListSelector("Item_")
accessor Items = new ListPageObject(ItemControl);
```

## Hard Rules

1. Use `accessor` on all decorated members
2. Do **not** put `@RootSelector` on a `PageObject` subclass—use `RootPageObject` instead
3. Never use `PageObject` as a root; only use it for nested controls
4. For nested `PageObject` subclasses with custom constructors, implement `cloneWithContext()`
5. `createFixtures()` only works for classes constructible as `new X(page)`. For extra args, write a custom fixture
6. **Preserve the user's existing style.** Do not force built-in POM adoption unless explicitly requested

## Style Selection Cheat Sheet

### Plain Class + Decorators
✅ Incremental adoption, existing Playwright patterns, no inheritance needed

```ts
@RootSelector("CheckoutPage")
class CheckoutPage {
	constructor(readonly page: Page) {}
	@Selector("Promo")
	accessor PromoInput!: Locator;
}
```

### Page-Only Host
✅ Lightweight, globally unique test ids, minimal boilerplate

```ts
class CheckoutPage {
	constructor(readonly page: Page) {}
	@Selector("Promo")
	accessor PromoInput!: Locator;
}
```

### Fragment (Reusable Sub-tree)
✅ Nested UI components, own child selectors, shared across pages

```ts
class PromoSection {
	constructor(readonly locator: Locator) {}
	@Selector("CodeInput")
	accessor CodeInput!: Locator;
}

// Used in parent:
@Selector("PromoSection", PromoSection)
accessor promo!: PromoSection;
```

### External Controls
✅ Existing control libraries, typed helpers, no `PageObject` inheritance

```ts
class InputControl {
	constructor(readonly locator: Locator) {}
	async fill(value: string) { await this.locator.fill(value); }
}

@Selector("Promo", InputControl)
accessor PromoInput!: InputControl;
```

### Built-In POM
✅ Need `$`, wait helpers (`.waitVisible()`, `.waitText()`), soft assertions, many nested controls

```ts
class CheckoutPage extends RootPageObject {
	@Selector("Promo")
	accessor PromoInput = new PageObject();
	
	async applyPromo(code: string) {
		await this.PromoInput.waitVisible();
		await this.PromoInput.$.fill(code);
	}
}
```

## Lists

### ListPageObject (stateful helpers)
Use when you need iteration, filtering, or item lookup:

```ts
@ListSelector("CartItem_")
accessor Items = new ListPageObject(CartItemControl);

await list.waitCount(3);
const item = list.getItemByText("Apple");
for await (const row of list.items) { /* ... */ }
```

### Raw Locator (pure Playwright)
Use when you want `.nth()`, `.count()`, and basic element operations:

```ts
@ListSelector("CartItem_")
accessor ItemRows!: Locator;

const count = await itemRows.count();
const first = itemRows.nth(0);
```

**Tip:** Use prefixed row ids (`CartItem_1`, `CartItem_2`) with `@ListSelector("CartItem_")` to avoid collision with child ids like `CartItemName`.

## Fixtures

### With createFixtures()
Automatic wiring for classes constructible as `new Class(page)`:

```ts
export const test = base.extend(
	createFixtures({ checkoutPage: CheckoutPage }),
);

test("...", async ({ checkoutPage }) => {
	await checkoutPage.PromoInput.fill("CODE");
});
```

**Supports:** `RootPageObject`, `@RootSelector(...)` classes, page-only hosts

**Does not support:** Classes with extra constructor arguments

### Manual instantiation
Still valid and sometimes simpler:

```ts
test("...", async ({ page }) => {
	const checkout = new CheckoutPage(page);
	await checkout.PromoInput.fill("CODE");
});
```

## Common Issues & Solutions

### Issue: "How do I choose between root decorator and page-only host?"
**Solution:** Use `@RootSelector("ContainerId")` if the page has a container test id you want to scope. Otherwise, skip it (page-only). Prefer page-only when test ids are globally unique.

### Issue: "My child selector doesn't resolve."
**Solution:** Check context resolution order:
1. Is the parent a decorated root or has `@RootSelector`?
2. Does the parent have a `locator` property (fragment)?
3. Does the parent have a `page` property?
4. Are decorators using `accessor`?

### Issue: "Can I mix raw Locators and PageObjects in one class?"
**Solution:** Yes. Mix accessor types freely. Return raw `Locator` where you don't need helpers, and `PageObject` where you do.

### Issue: "I have an external control library. Do I use it?"
**Solution:** Yes. Pass your control class as the second argument to `@Selector(...)`. If it doesn't accept `Locator` in its constructor, wrap it first.

### Issue: "Do I have to use createFixtures()?"
**Solution:** No. It's optional. Manual `new CheckoutPage(page)` is valid. Use fixtures only if your test suite already relies on them.

## Recommended Adoption Path

Unless the user explicitly asks for a full built-in POM:

1. **Start small:** Add `@Selector(...)` to plain classes, keep raw `Locator` accessors
2. **Extract controls:** When selectors repeat, move to external classes
3. **Add POM helpers only where they add value:** Use `PageObject` / `ListPageObject` for wait/filter/iterate operations
4. These three styles coexist—no all-or-nothing commitment required

## Examples to Reference

When in doubt, direct the user to:

- **Scoped root:** [CheckoutPage.ts](example/e2e/page-objects/CheckoutPage.ts)
- **Page-only host:** [PlainHostCheckoutPage.ts](example/e2e/page-objects/PlainHostCheckoutPage.ts)
- **Fragment:** [PromoSectionFragment.ts](example/e2e/page-objects/PromoSectionFragment.ts)
- **External controls:** [ExternalCheckoutPage.ts](example/e2e/page-objects/ExternalCheckoutPage.ts)
- **Fixtures:** [fixtures.ts](example/e2e/fixtures.ts)
- **Built-in POM tests:** [PageObject.advanced.spec.ts](src/tests/page-objects/PageObject.advanced.spec.ts)

For complete decorator and API reference, read [README.md](README.md).

## Principle: Decoration, Not Prescription

This library decorates your selectors; it does not dictate your class hierarchy. Favor the user's existing patterns. Mix styles as needed. Inheritance (via `RootPageObject` or `PageObject`) is optional—a convenience, not a requirement.