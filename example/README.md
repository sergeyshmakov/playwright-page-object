# playwright-page-object Example

A minimal React checkout app with Playwright E2E tests demonstrating the full power of `playwright-page-object`.

## Run the App

```bash
npm run dev
```

Open http://localhost:5173

## Run Tests

1. From the repo root, build the package and run example tests:

```bash
npm run build
npm run test:example
```

2. Or from the example folder (after building the parent):

```bash
cd ..
npm run build
cd example
npm install
npm run test:e2e
```

Note: If you see "Requiring @playwright/test second time", use a packed install: `npm pack --pack-destination .` in the root, then `npm install ../playwright-page-object-1.0.0.tgz` in the example.

## What This Example Demonstrates

### Control Graph

Page objects compose into a typed graph:

```
CheckoutPage (@RootSelector)
├── PromoCodeInput (@Selector)
├── ApplyPromoButton (@SelectorByRole)
├── CartItems (@ListSelector CartItem_*)
│   └── CartItemControl
│       └── RemoveButton (@SelectorByRole)
└── CartItemRows (@ListSelector CartItem_*) — raw Locator, no ListPageObject
```

Cart line rows use `data-testid` values `CartItem_${id}` in `CartItem.tsx`, so `@ListSelector("CartItem_")` matches every row without colliding with `CartItemName` / `CartItemPrice`.

### Custom Methods (Repeatable Logic)

Controls encapsulate common checks and actions:

```typescript
// CheckoutPage
async applyPromoCode(code: string) {
  await this.PromoCode.$.fill(code);
  await this.ApplyPromoButton.$.click();
}

async expectCartEmpty() {
  await this.CartItems.waitCount(0);
}

async expectCartHasItemCount(n: number) {
  await this.CartItems.waitCount(n);
}
```

### Fixtures

Tests receive `checkoutPage` via `createFixtures`—no manual instantiation:

```typescript
export const test = base.extend(
  createFixtures({ checkoutPage: CheckoutPage })
);

test("example", async ({ checkoutPage }) => {
  await checkoutPage.applyPromoCode("SAVE20");
  await checkoutPage.expectCartHasItemCount(2);
});
```

### Async Iteration

Iterate over list items with `for await`:

```typescript
for await (const item of checkoutPage.CartItems.items) {
  await item.expect({ soft: true }).toBeVisible();
}
```

### Variable Reusability

`ButtonControl` is reused for Apply, Remove, and other buttons—selectors stay relative to their parent.

### Filtering

```typescript
const widgetItems = checkoutPage.CartItems.filterByText("Widget");
await widgetItems.expect().toHaveCount(2);

const widgetB = checkoutPage.CartItems.filterByText("Widget B").first();
await widgetB.RemoveButton.$.click();
```

`filterByText()` returns a narrowed `ListPageObject`. Call `.first()`, `.second()`, or `.at(...)` when you need a single matched item.

## Full API

See the [main package README](../README.md) for the complete API reference.
