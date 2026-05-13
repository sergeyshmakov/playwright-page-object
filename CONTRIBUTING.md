# Contributing to `playwright-page-object`

Thanks for taking the time to contribute.

This project is maintained by a single person in their free time. The guidelines below keep things moving smoothly and respect everyone's time.

## Code of Conduct

By participating in this project, you agree to abide by the [Code of Conduct](.github/CODE_OF_CONDUCT.md).

## Talk first for non-trivial work

- **Bugs and typos:** open a pull request directly. No need to ask.
- **New features and breaking changes:** open an issue first so we can agree on scope and design before you invest time in a PR.

This prevents the painful case of a large PR being rejected because of a direction we could have settled in a five-minute discussion.

## Local development

```bash
npm ci
npm run dev      # tsup watch mode
npm test         # vitest
npm run lint     # biome check
```

## Code style

Formatting and linting are handled by [Biome](https://biomejs.dev/). A Husky pre-commit hook formats staged files automatically. To run it manually:

```bash
npm run lint:fix
```

No editor configuration is required.

## Commits and releases

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: ...` — minor version bump
- `fix: ...` — patch version bump
- `docs: ...`, `chore: ...`, `refactor: ...` — no release

Releases are automated via `semantic-release` on merge to `main`. Do not bump the version in `package.json` manually.

## Docs

The documentation site lives in [`docs/`](./docs) and is built with Astro Starlight. To preview locally:

```bash
cd docs
npm install
npm run dev
```

Public-API changes should be reflected in the relevant guide and API reference pages.
