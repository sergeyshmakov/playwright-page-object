Let me first research the current landscape — existing packages, name availability, and MCP ecosystem state — before refining the document., Now let me generate the refined document:, Let me compose the final document directly. Here's my analysis and the refined output:

---

## My Analysis of Your Idea

**What's strong:**

1. **The "everything is a PageObject" philosophy** is the right call. Most POM libraries force an artificial page-vs-component hierarchy that breaks the moment you have a modal that contains a form that appears on 4 different pages. Your flat model with `@RootSelector` as the only "promotion" mechanism is elegant.

2. **The `accessor` keyword choice** is technically sharp. TC39 decorators (Stage 3, shipped in TypeScript 5.0+) need `accessor` for auto-accessors that give you both get/set hooks. This isn't a gimmick — it's the *only* way to intercept property access without Proxy. You should emphasize this isn't experimental anymore — it's part of ES2025.

3. **Bundled MCP server is the killer differentiator.** The landscape today:
   - **POMWright** (~41 GitHub stars) is closest to you — TypeScript, locator chaining, complementary to Playwright — but has zero AI story.
   - **POMify** (npmjs: `pomify`, v0.8.6, dormant ~2 years) — simpler, no decorators, no MCP.
   - **@playwright/mcp** (Microsoft's official) — browser automation only, outputs raw selectors, no awareness of user's POM structure.
   - **Nobody** offers a static control graph served over MCP. This is genuinely a gap.

4. **The two-phase pipeline** (your MCP for structure → `@playwright/mcp` for verification) is a compelling narrative. The "self-healing through centralized typed controls" pitch is exactly right.

**What needs refinement:**

1. **Naming:** `playwright-pom` has namespace collision issues — `playwright-pom-materials` exists on npm, there's an ESLint plugin `@kinosuke01/eslint-plugin-playwright-pom`, and every blog post about Playwright + POM saturates that keyword. `playwright-page-object` is available and cleaner, but still generic. See my suggestions in the doc.

2. **The abstractions table is premature.** `ModalPageObject`, `FormPageObject`, `TablePageObject` are all opinionated and could limit adoption. I'd suggest shipping v1 with only `PageObject` + `ListPageObject` + decorators + MCP, and releasing abstractions as `playwright-page-object/extras` or a separate phase.

3. **MCP tool surface is too wide for v1.** Tools like `suggest_missing_controls`, `find_duplicate_selectors`, and `generate_page_object` are Phase 2-3. The doc should separate "launch" from "roadmap."

4. **Missing: how you handle `data-testid` vs other selector strategies.** The doc implies `@Selector("ApplyButton")` maps to `data-testid="ApplyButton"` but never states it explicitly, nor does it show how to opt into role/text/label selectors at the accessor level (only at root level).

5. **Missing: Playwright fixture integration.** Real-world Playwright users extend `test` with custom fixtures. You need a `createFixture<T>(PageClass)` or similar.

---

Here's the refined document:

---

# `playwright-page-object` — Solution DNA & Architecture

## Name Candidates

| Name | npm Available | SEO Clarity | Notes |
|---|---|---|---|
| `playwright-page-object` | ✅ Yes | High — exact concept | **Recommended.** Clear, searchable, no collisions |
| `playwright-pom` | ⚠️ Crowded keyword | Low — collides with every POM tutorial | `playwright-pom-materials` already exists |
| `pw-controls` | ✅ Yes | Medium | Short, but loses "page object" discoverability |
| `playwright-control-graph` | ✅ Yes | Medium | Emphasizes the MCP/graph angle |
| `@playwright-tools/page-object` | ✅ Scoped | High | Scoped namespace, room for `@playwright-tools/mcp` later |

**Recommendation:** Go with **`playwright-page-object`**. It wins on npm search, Google SEO, and instant concept recognition. The MCP sub-export (`playwright-page-object/mcp`) naturally inherits the name.

---

## What It Is

`playwright-page-object` is a TypeScript-first Page Object Model framework for Playwright that replaces raw `page.locator()` chains with a **typed, composable, decorator-driven control graph**.

Every piece of UI becomes a class. Every selector becomes a typed accessor. Every test becomes a readable composition of controls. And the full control graph is exposed to AI coding assistants via a bundled MCP server — no browser needed.

---

## Core Philosophy

> A PageObject is any object that represents a piece of UI — a full page, a section, a modal, a button. There is no hierarchy of "pages" vs "components". Everything is a `PageObject`, and `@RootSelector` is what promotes one to a test entry point.

| Principle | Meaning |
|---|---|
| **Typed over stringly-typed** | No raw selector strings in tests, ever |
| **Composable over flat** | Controls nest inside controls, mirroring actual UI structure |
| **Lazy over eager** | Locator chains rebuild on every access, enabling context reuse |
| **Static over runtime** | The full control graph is analyzable without running any browser |
| **Minimal core, optional extras** | Ship `PageObject` + `ListPageObject` + decorators. Abstractions are opt-in. |

---

## Competitive Landscape

| Library | Typed Controls | Decorator-based | Nested Composition | MCP / AI Layer | Active |
|---|---|---|---|---|---|
| Manual POM (Playwright docs) | ❌ | ❌ | ❌ | ❌ | — |
| **POMWright** | ✅ | ❌ (config-based) | ✅ | ❌ | ✅ (~41★) |
| **POMify** (`pomify`) | Partial | ❌ | ❌ | ❌ | ❌ (dormant 2y) |
| **@ddspog/pom** (JSR) | Partial | ❌ | ❌ | ❌ | New |
| **playwright-page-object** | ✅ | ✅ `accessor` decorators | ✅ Recursive graph | ✅ Bundled MCP | **You** |

**Gap you fill:** Nobody offers a typed, decorator-driven control graph that is simultaneously consumable by AI tools at development time.

---

## Architecture

### Layer 1 — Base

```typescript
class PageObject {
  // locator: protected, rebuilt lazily via selector chain
  // Actions: click(), hover(), waitVisible(), waitText(), waitCount()...
  // cloneWithContext(): the single override contract for custom constructors
}
```

- `locator` is **protected** — tests never touch raw Playwright locators
- `selector` setter is **protected** — set only at construction or clone time
- `cloneWithContext()` is the extension point when subclasses have constructor args

### Layer 2 — Decorators

```typescript
@Selector("ApplyButton")               // → data-testid="ApplyButton"
accessor ApplyButton = new ButtonControl();

@SelectorByRole("button", { name: "Submit" })  // → getByRole('button', { name: 'Submit' })
accessor SubmitBtn = new ButtonControl();

@ListSelector("ChildItem")             // → data-testid="ChildItem" (repeated)
accessor Children = new ListPageObject(ChildItemControl);
```

**Why `accessor`?** The `accessor` keyword (ES2025/TC39 auto-accessors, stable in TypeScript 5.0+) provides both a backing store and a getter hook. On every property access, the decorator rebuilds the full `root → parent → selector` locator chain. This is not experimental — it's the only mechanism that enables lazy chain rebuilding without Proxy.

**Selector strategy is explicit per-decorator:**

| Decorator | Resolves to |
|---|---|
| `@Selector(id)` | `data-testid="id"` (default strategy, configurable) |
| `@SelectorByRole(role, opts?)` | `page.getByRole(role, opts)` |
| `@SelectorByText(text)` | `page.getByText(text)` |
| `@SelectorByLabel(label)` | `page.getByLabel(label)` |
| `@ListSelector(id)` | `data-testid="id"` on repeated elements |

### Layer 3 — Entry Points

```typescript
@RootSelector("CheckoutPage")
class CheckoutPage extends PageObject {
  @Selector("PromoCode") accessor PromoCode = new InputControl();
  @ListSelector("CartItem") accessor CartItems = new ListPageObject(CartItemControl);
}

// In tests:
const checkout = new CheckoutPage(playwrightPage);
await checkout.CartItems.getByIndex(0).RemoveButton.click();
```

`@RootSelector` is the **only** class-level decorator. Variants: `@RootSelectorByRole`, `@RootSelectorByText`, `@RootSelectorByLabel`.

### Layer 4 — Collections

```typescript
class ListPageObject<T extends PageObject> {
  getByIndex(n: number): T               // zero-based, returns typed child
  getAll(): Promise<T[]>                  // resolves all current matches
  find(pred: (item: T) => Promise<boolean>): Promise<T | undefined>
  filter(pred: (item: T) => Promise<boolean>): Promise<T[]>
  waitCount(n: number): Promise<void>     // assert expected count
  count(): Promise<number>
}
```

### Layer 5 — Playwright Fixture Integration

```typescript
import { test as base } from '@playwright/test';
import { createFixtures } from 'playwright-page-object';

const test = base.extend(createFixtures({
  checkoutPage: CheckoutPage,
  loginPage: LoginPage,
}));

test('apply promo code', async ({ checkoutPage }) => {
  await checkoutPage.PromoCode.fill('SAVE20');
  await checkoutPage.ApplyButton.click();
});
```

---

## Built-in Abstractions (Phase 2 — `playwright-page-object/extras`)

> Ship these **after** the core stabilizes. They are opinionated by design.

| Class | Adds |
|---|---|
| `ModalPageObject` | `waitOpen()`, `waitClosed()`, `closeByOverlay()` |
| `FormPageObject` | `submit()`, `waitFieldError(field)`, `fillAll(data)` |
| `TablePageObject<TRow>` | Headers, sort, pagination, typed row access |
| `DropdownControl` | `select(value)`, `waitOptions()`, `getSelected()` |

---

## MCP Server — The AI Layer

Bundled as `playwright-page-object/mcp`. Installed automatically alongside the core package.

### How It Works

The MCP server uses the **TypeScript Compiler API** to parse your `PageObject` classes statically — no browser, no runtime. It builds a typed dependency graph and serves it to LLMs on demand.

```jsonc
// .cursor/mcp.json
{
  "mcpServers": {
    "playwright-page-object": {
      "command": "npx",
      "args": ["playwright-page-object/mcp", "--dir", "./src/tests/controls"]
    }
  }
}
```

### MCP Tools — Phase 1 (Launch)

**Discovery**
| Tool | Description |
|---|---|
| `list_root_pages` | All `@RootSelector` entry points with their class names and selectors |
| `get_page_object_tree(className, depth?)` | Full nested control tree for a class |
| `find_control(name)` | Every class exposing a given accessor name |
| `search_controls(query)` | Fuzzy search across all accessor and class names |

**Context Optimization**
| Tool | Description |
|---|---|
| `get_test_context(filePath)` | Resolves which page objects a test file uses, returns their trees |
| `get_minimal_context(accessorChain)` | Given `CheckoutPage.CartItems.RemoveButton`, returns only the classes in that chain — maximum token efficiency |

**Code Generation**
| Tool | Description |
|---|---|
| `generate_test_scaffold(rootClass, scenario)` | Typed test skeleton with correct imports and accessor chains |

### MCP Tools — Phase 2 (Post-Launch)

| Tool | Description |
|---|---|
| `get_control_actions(className, controlPath)` | Available methods on a specific nested control |
| `get_dependency_graph()` | Full cross-class dependency map |
| `generate_page_object(description, parentClass?)` | Scaffolds a PageObject from plain-text description |
| `validate_page_object(className)` | Missing decorators, missing `cloneWithContext` overrides |
| `find_duplicate_selectors()` | Test IDs used in conflicting locations |
| `suggest_missing_controls(className)` | Compares against sibling classes to find gaps |

---

## Automated Test Generation Pipeline

Your MCP composes with Microsoft's `@playwright/mcp` into a pipeline nobody else offers:

```
Phase 1 — Structure (playwright-page-object/mcp):
  get_page_object_tree("CheckoutPage")
  → returns typed accessor graph, zero DOM access needed

Phase 2 — Generation:
  generate_test_scaffold("CheckoutPage", "user adds 2 children with age 5 and 7")
  → returns fully typed test using decorator-based accessors

Phase 3 — Verification (@playwright/mcp):
  LLM runs the generated test, observes failures, iterates
```

### Why This Beats Existing Approaches

| Tool | Output | Maintainable? | Uses your controls? |
|---|---|---|---|
| Playwright Codegen | Raw `page.locator()` strings | ❌ | ❌ |
| `@playwright/mcp` (Microsoft) | Raw selectors from DOM snapshot | ❌ | ❌ |
| POMify | Basic POM without AI awareness | ⚠️ | ❌ |
| POMWright | Config-based locator chains | ✅ | ❌ (no MCP) |
| **playwright-page-object/mcp** | Typed accessor chains from your graph | ✅ | ✅ |

**Self-healing through centralized typed controls** — when a selector changes, you fix it once in the PageObject class. All tests using that accessor auto-heal. No AI guessing new selectors.

---

## Package Structure

```
playwright-page-object/
├── src/
│   ├── index.ts                  # PageObject, ListPageObject, all decorators
│   ├── controls/                 # ButtonControl, InputControl (thin typed wrappers)
│   ├── fixtures.ts               # createFixtures() for Playwright test.extend
│   ├── extras/                   # Phase 2: Modal, Form, Table, Dropdown
│   │   ├── ModalPageObject.ts
│   │   ├── FormPageObject.ts
│   │   └── TablePageObject.ts
│   └── mcp/
│       ├── index.ts              # MCP server entry (npx playwright-page-object/mcp)
│       ├── parser.ts             # TS Compiler API → control graph builder
│       ├── tools.ts              # MCP tool definitions
│       └── graph.ts              # Dependency graph data structures
├── package.json
│   exports:
│     ".":        "./dist/index.js"
│     "./extras": "./dist/extras/index.js"
│     "./mcp":    "./dist/mcp/index.js"
```

---

## Release Phases

| Phase | Scope | Goal |
|---|---|---|
| **v0.1** — Core | `PageObject`, `ListPageObject`, all decorators, `createFixtures()` | Usable POM library, gather feedback |
| **v0.2** — MCP | Bundled MCP server with Phase 1 tools | AI differentiation, drive early adopters |
| **v0.3** — Extras | `ModalPageObject`, `FormPageObject`, `TablePageObject` | Cover common patterns |
| **v0.4** — MCP Phase 2 | Validation, generation, dependency graph tools | Full AI pipeline |
| **v1.0** — Stable | API freeze, docs site, starter templates | Production-ready |

---

## Positioning

> **The only Playwright POM library where your typed control graph becomes a first-class context source for AI coding assistants.**

- **For QA engineers:** Structured, maintainable, typed page objects — zero raw selectors in tests
- **For developer teams:** MCP server turns existing controls into instant AI context — LLMs write correct tests on the first try
- **For AI-first workflows:** Composable with any MCP-compatible client (Cursor, Copilot, Claude Desktop, Windsurf)

---

## Open Questions to Resolve

1. **Default selector strategy:** Is `data-testid` the right default for `@Selector()`, or should it be configurable globally (e.g., `data-cy`, `data-qa`)?
2. **Chain visualization:** Should the MCP server output a visual tree (Mermaid diagram) or just structured JSON?
3. **Framework coupling:** Should `@playwright/test` be a peer dependency or optional? (Supporting both `@playwright/test` and library-mode Playwright)
4. **Selector auto-discovery:** Phase 3 idea — parse the actual app's component tree (React DevTools protocol, etc.) to suggest missing PageObject fields?

---

*Document version: 2026-03-04 — Living document, updated as architecture decisions are finalized.*
