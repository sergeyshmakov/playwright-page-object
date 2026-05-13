# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-05-13T12:06:59.574Z
> Files: 126 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `.gitattributes` — Git attributes (~124 tok)
- `.gitignore` — Git ignore rules (~58 tok)
- `.lintstagedrc` (~28 tok)
- `.mcp.json` (~60 tok)
- `.npmrc` (~10 tok)
- `biome.json` — Biome linter/formatter configuration (~157 tok)
- `CLAUDE.md` — OpenWolf (~57 tok)
- `commitlint.config.js` (~20 tok)
- `CONTRIBUTING.md` — Contributing to `playwright-page-object` (~598 tok)
- `LICENSE` — Project license (~212 tok)
- `OSS_POLISH.md` — OSS Polish Checklist (~2440 tok)
- `package-lock.json` — npm lock file (~77400 tok)
- `package.json` — Node.js package manifest (~742 tok)
- `playwright-page-object.tgz` (~4447 tok)
- `README.md` — Project documentation (~3273 tok)
- `tsconfig.json` — TypeScript configuration (~62 tok)
- `vitest.config.ts` — Vitest test configuration (~43 tok)

## .claude/

- `settings.json` (~500 tok)
- `settings.local.json` (~36 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## .github/

- `dependabot.yml` (~143 tok)

## .github/workflows/

- `pr.yml` — CI: PR Check (~160 tok)
- `publish.yml` — CI: Publish Package (~256 tok)

## .husky/

- `commit-msg` (~10 tok)
- `pre-commit` (~12 tok)

## .husky/_/

- `.gitignore` — Git ignore rules (~1 tok)
- `applypatch-msg` (~11 tok)
- `commit-msg` (~11 tok)
- `h` (~147 tok)
- `husky.sh` (~46 tok)
- `post-applypatch` (~11 tok)
- `post-checkout` (~11 tok)
- `post-commit` (~11 tok)
- `post-merge` (~11 tok)
- `post-rewrite` (~11 tok)
- `pre-applypatch` (~11 tok)
- `pre-auto-gc` (~11 tok)
- `pre-commit` (~11 tok)
- `pre-merge-commit` (~11 tok)
- `pre-push` (~11 tok)
- `pre-rebase` (~11 tok)
- `prepare-commit-msg` (~11 tok)

## docs/

- `.gitignore` — Git ignore rules (~52 tok)
- `astro.config.mjs` — Astro configuration (~492 tok)
- `package.json` — Node.js package manifest (~98 tok)
- `tsconfig.json` — TypeScript configuration (~31 tok)

## docs/src/

- `content.config.ts` — Exports collections (~77 tok)

## docs/src/content/docs/

- `index.mdx` — Before / after (~760 tok)

## docs/src/content/docs/getting-started/

- `choosing-a-style.mdx` — Host patterns (~975 tok)
- `installation.mdx` — Install (~412 tok)
- `quick-start.mdx` — 1. Define a page object (~688 tok)

## docs/src/content/docs/guides/

- `built-in-pom.mdx` — Root: `RootPageObject` (~1039 tok)
- `custom-controls.mdx` — Minimal example (~824 tok)
- `fragments.mdx` — Minimal example (~689 tok)
- `lists.mdx` — With `ListPageObject` (~975 tok)
- `page-only-hosts.mdx` — Minimal example (~503 tok)
- `plain-classes.mdx` — Minimal example (~665 tok)

## evals/

- `evals.json` (~349 tok)

## example/

- `index.html` — Checkout Demo (~84 tok)
- `package-lock.json` — npm lock file (~16648 tok)
- `package.json` — Node.js package manifest (~178 tok)
- `playwright.config.ts` — Playwright test configuration (~150 tok)
- `README.md` — Project documentation (~696 tok)
- `tsconfig.json` — TypeScript configuration (~150 tok)
- `tsconfig.node.json` (~52 tok)
- `tsconfig.tsbuildinfo` (~49 tok)
- `vite.config.ts` — Vite build configuration (~39 tok)

## example/e2e/

- `checkout.spec.ts` — Declares firstItem (~700 tok)
- `external-controls.spec.ts` — E2E tests demonstrating external controls (not extending PageObject) (~342 tok)
- `fixtures.ts` — Exports test (~180 tok)
- `plain-host-checkout.spec.ts` (~302 tok)

## example/e2e/page-objects/

- `CartItemControl.ts` — Exports CartItemControl (~95 tok)
- `CheckoutPage.ts` — PageObject approach: use PromoCode.$.fill() (~407 tok)
- `ExternalCheckoutPage.ts` — Demonstrates a root page object that does NOT extend `PageObject`. (~496 tok)
- `PlainHostCheckoutPage.ts` — Same controls as {@link CheckoutPage}, but the host is a plain class with (~419 tok)
- `PromoSectionFragment.ts` — Fragment control: receives the section root from `@Selector("PromoSection", …)` and (~121 tok)

## example/e2e/page-objects/controls/

- `ButtonControl.ts` — Exports ButtonControl (~30 tok)
- `ExternalButtonControl.ts` — An example of an external control that does NOT extend `PageObject`. (~166 tok)
- `ExternalInputControl.ts` — An external input control that accepts the locator as a constructor argument. (~169 tok)

## example/playwright-report/

- `index.html` — Playwright Test Report (~143567 tok)

## example/src/

- `App.tsx` — INITIAL_CART — uses useState (~248 tok)
- `index.css` (~26 tok)
- `main.tsx` (~65 tok)
- `vite-env.d.ts` — / <reference types="vite/client" /> (~11 tok)

## example/src/components/

- `CartItem.tsx` — CartItem (~158 tok)
- `CheckoutPage.tsx` — CheckoutPage (~352 tok)
- `Header.tsx` — Header (~50 tok)

## example/test-results/

- `.last-run.json` (~13 tok)

## run/

- `pack-example-package.mjs` — rootDir: spawnCommand, run, capture, main (~593 tok)

## run/_/

- `.gitignore` — Git ignore rules (~1 tok)
- `applypatch-msg` (~11 tok)
- `commit-msg` (~11 tok)
- `h` (~147 tok)
- `husky.sh` (~46 tok)
- `post-applypatch` (~11 tok)
- `post-checkout` (~11 tok)
- `post-commit` (~11 tok)
- `post-merge` (~11 tok)
- `post-rewrite` (~11 tok)
- `pre-applypatch` (~11 tok)
- `pre-auto-gc` (~11 tok)
- `pre-commit` (~11 tok)
- `pre-merge-commit` (~11 tok)
- `pre-push` (~11 tok)
- `pre-rebase` (~11 tok)
- `prepare-commit-msg` (~11 tok)

## skills/playwright-page-object/

- `SKILL.md` — playwright-page-object Agent Skill (~2378 tok)

## src/

- `fixtures.ts` — Map of fixture names to PageObject constructors or factory functions. (~828 tok)
- `index.ts` (~266 tok)
- `protocol.ts` — Internal symbol key used by decorators to store a resolved `Locator` (~177 tok)

## src/decorators/

- `rootSelectors.ts` — Class decorator: sets root locator by test id regex. Use for list containers (~1798 tok)
- `selectorBy.ts` — Fragment / factory controls often use `constructor(readonly locator: Locator)`. (~1132 tok)
- `selectors.ts` — Accessor decorator: locator by test id regex. Use for list items sharing a pattern. (~2333 tok)

## src/page-objects/

- `ListPageObject.ts` — Page object for a list of items, each represented by a `TItem` page object. (~2389 tok)
- `PageObject.ts` — Function type that derives a {@link Locator} from a root locator. (~1574 tok)
- `RootPageObject.ts` — Constructor signature for top-level root page objects. (~366 tok)

## src/tests/

- `fixtures.spec.ts` — FixtureFn: invokeFixture, getFixture (~1410 tok)

## src/tests/decorators/

- `rootSelectors.spec.ts` — Declares getLocator (~1500 tok)
- `selectorBy.spec.ts` — Declares SelectorType (~1158 tok)
- `selectors-external.spec.ts` — Declares ExternalButton (~1502 tok)
- `selectors-page-fallback.spec.ts` — Declares SelectorType (~1225 tok)
- `selectors.spec.ts` — Declares SelectorType (~3021 tok)

## src/tests/mocks/

- `playwright.ts` — Exports MockLocator, MockPage, createMockLocator, createMockPage (~802 tok)

## src/tests/page-objects/

- `ListPageObject.spec.ts` — Declares SelectorType (~5390 tok)
- `PageObject.advanced.spec.ts` — SelectorType: locator, tooltipElement, locator (~1331 tok)
- `PageObject.spec.ts` — Declares SelectorType (~2412 tok)
