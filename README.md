# playwright-page-object

Typed, decorator-driven Page Object Model for Playwright. Reusable, lazy locator chains in plain TypeScript classes.

[![npm version](https://img.shields.io/npm/v/playwright-page-object.svg)](https://www.npmjs.com/package/playwright-page-object)
[![CI](https://github.com/sergeyshmakov/playwright-page-object/actions/workflows/pr.yml/badge.svg)](https://github.com/sergeyshmakov/playwright-page-object/actions/workflows/pr.yml)
[![Bundle size](https://img.shields.io/bundlephobia/minzip/playwright-page-object)](https://bundlephobia.com/package/playwright-page-object)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178c6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

**Documentation:** [https://sergeyshmakov.github.io/playwright-page-object/](https://sergeyshmakov.github.io/playwright-page-object/)

---

## Before / after

```ts
// Before — selectors duplicated, structure invisible
await page.getByTestId("CheckoutPage").getByTestId("PromoCodeInput").fill("SAVE20");
await page.getByTestId("CheckoutPage").getByRole("button", { name: "Apply" }).click();
```

```ts
// After — typed, composable, reusable
await checkoutPage.applyPromoCode("SAVE20");
```

## What it is

A locator-composition layer, not a framework. Decorators scope a class to a Playwright locator; child decorators resolve relative to that scope. The accessor type determines output: raw `Locator`, a custom control, or a built-in `PageObject`.

- No inheritance required for basic use
- Lazy locator chains rebuild only when accessed
- Three output styles coexist in the same suite
- TypeScript-first, ECMAScript decorators (no `experimentalDecorators` needed)

## Install

```bash
npm install -D playwright-page-object
```

**Requirements:**

- Node `>=20`
- `@playwright/test >=1.35.0`
- TypeScript `>=5.0` (with `target: "ES2015"` or higher)

## Quick start

```ts
import type { Locator, Page } from "@playwright/test";
import { RootSelector, Selector, SelectorByRole } from "playwright-page-object";

@RootSelector("CheckoutPage")
class CheckoutPage {
  constructor(readonly page: Page) {}

  @Selector("PromoCodeInput")
  accessor PromoCodeInput!: Locator;

  @SelectorByRole("button", { name: "Apply" })
  accessor ApplyButton!: Locator;

  async applyPromoCode(code: string) {
    await this.PromoCodeInput.fill(code);
    await this.ApplyButton.click();
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

See the [Quick Start guide](https://sergeyshmakov.github.io/playwright-page-object/getting-started/quick-start/) for fixtures, page-only hosts, and the next steps.

## Output styles

Three styles, picked per accessor. Mix freely in the same class.

### Raw `Locator`

Minimal abstraction. Typed accessor, no helpers.

```ts
@Selector("PromoCodeInput")
accessor PromoCodeInput!: Locator;
```

[Plain Classes guide →](https://sergeyshmakov.github.io/playwright-page-object/guides/plain-classes/)

### Custom controls

Pass any class whose constructor accepts a `Locator`. Reuse your existing control library.

```ts
@Selector("PromoCodeInput", InputControl)
accessor PromoCode!: InputControl;
```

[Custom Controls guide →](https://sergeyshmakov.github.io/playwright-page-object/guides/custom-controls/)

### Built-in POM

`PageObject` / `ListPageObject` for wait helpers, soft assertions, and filter chains.

```ts
class CheckoutPage extends RootPageObject {
  @Selector("PromoCodeInput")
  accessor PromoCode = new PageObject();

  async applyPromo(code: string) {
    await this.PromoCode.waitVisible();
    await this.PromoCode.$.fill(code);
  }
}
```

[Built-In POM guide →](https://sergeyshmakov.github.io/playwright-page-object/guides/built-in-pom/)

## Context resolution

Child decorators resolve in this order: a `@RootSelector`-managed locator, then a `locator` property on the host, then `page.locator("body")` if `page` is present. The first match wins.

[Context Resolution reference →](https://sergeyshmakov.github.io/playwright-page-object/reference/context-resolution/)

## Documentation

The full documentation site covers every guide, the API reference, and the v1 → v2 migration:

**[https://sergeyshmakov.github.io/playwright-page-object/](https://sergeyshmakov.github.io/playwright-page-object/)**

- [Getting Started](https://sergeyshmakov.github.io/playwright-page-object/getting-started/installation/) — install, quick start, choosing a style
- [Guides](https://sergeyshmakov.github.io/playwright-page-object/guides/plain-classes/) — plain classes, fragments, custom controls, built-in POM, lists, fixtures, incremental adoption
- [Reference](https://sergeyshmakov.github.io/playwright-page-object/reference/context-resolution/) — context resolution, migration v1 → v2, troubleshooting
- [API](https://sergeyshmakov.github.io/playwright-page-object/api/decorators/) — decorators, `PageObject`, `RootPageObject`, `ListPageObject`, `createFixtures`

## AI tooling

This package ships an [Agent Skills](https://agentskills.io/)-compatible skill so AI assistants load library-specific guidance on demand:

```bash
npx ctx7 skills install /sergeyshmakov/playwright-page-object playwright-page-object
```

It is also indexed in [Context7](https://context7.com/) and documented in a [Cubic wiki](https://www.cubic.dev/wikis/sergeyshmakov/playwright-page-object). See [AI Tooling](https://sergeyshmakov.github.io/playwright-page-object/ai-tooling/agent-skills/) in the docs.

## Migrating from v1

See the [migration guide](https://sergeyshmakov.github.io/playwright-page-object/reference/migration-v1-to-v2/). Most changes are mechanical renames.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[ISC License](LICENSE)
