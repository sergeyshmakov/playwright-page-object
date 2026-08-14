# Agent instructions

## Commit prefixes decide whether npm publishes

`main` runs semantic-release on every push. The commit **subject prefix** is the
only thing that decides whether a new version goes to npm, so choosing it is a
release decision, not a formatting one.

| Prefix | Release |
| --- | --- |
| `feat:` | minor |
| `fix:` | patch |
| `perf:` | patch |
| `feat!:` / `BREAKING CHANGE:` footer | major |
| `docs:` `chore:` `ci:` `test:` `refactor:` `style:` `build:` | **none** |

### Changes under `docs/` always use `docs:`

The published package is `files: ["dist"]`. Nothing under `docs/` — the Starlight
site, its config, its styles, its content — ever reaches an npm consumer, so a
docs change must never cut a release.

Use `docs:` for everything in that directory, including behaviour changes such as
site scripts or CSS. It is still a documentation change from the package's point
of view, which is the only point of view semantic-release has.

**A scope does not exempt you.** `feat(docs):` cuts a minor release exactly like
`feat:` does — the default commit-analyzer reads the type and ignores the scope.
This has been caught in review; do not reintroduce it.

The same rule covers `example/` and any other directory outside `dist`.

### Dependabot follows the same rule

`.github/dependabot.yml` pins the prefix per ecosystem, deliberately:

- root `npm` → `fix(deps)` / `chore(deps-dev)`, so runtime-dependency and
  security bumps do reach npm.
- `/docs` and `/example` → `chore(deps)` / `chore(deps-dev)`, because neither
  ships. Dependabot's own default would pick `fix(deps)` for any
  *production-type* dependency — react and react-dom are production deps of the
  example app — and cut an empty patch release for a change present in nothing.

If you merge such a PR by hand, check the subject before squashing and rewrite it
if the prefix would release.

### Squash merges

`gh pr merge --squash` takes the **PR title** as the subject unless you pass
`--subject`. A PR title is not usually a conventional commit, so squashing
without `--subject` silently skips a release that was meant to happen. Pass the
subject explicitly and make it say what you intend.

## Before changing the MCP server's product text

`src/mcp/server.ts` holds `INSTRUCTIONS` and the five tool descriptions. That
text is loaded into every MCP session and is the only thing an agent reads before
its first call, so an inaccuracy there misleads every consumer at once.

Do not describe behaviour from the shape of the API or from the example app.
Read the implementation:

- what makes a class visible — `src/analysis/page-objects/discover.ts`
  (`DiscoveryEvidence` is `decorator | baseClass | fixture | factoryArg`, and a
  class whose *only* evidence is `factoryArg` is excluded from
  `list_page_objects`)
- the decorator names — `src/analysis/page-objects/libraryImports.ts`
- which locator calls the raw sweep matches — `src/analysis/coverage/usages.ts`
- which diagnostics come from where — `src/analysis/coverage/coverageWarnings.ts`
  raises `ui-scope-incomplete`; tree responses report boundaries through
  `fidelity` instead

`src/tests/mcp/instructions.spec.ts` asserts the claims that cannot be derived
from a constant. Add to it when you add a claim.

Prefer deriving text from the source of truth over restating it — `server.ts`
already interpolates the `format` default from the schema and the handle lifetime
from its constant, because both had drifted.
