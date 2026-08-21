# [2.2.0](https://github.com/sergeyshmakov/playwright-page-object/compare/v2.1.1...v2.2.0) (2026-08-21)


### Features

* make MCP coverage loop self-diagnosing ([#80](https://github.com/sergeyshmakov/playwright-page-object/issues/80)) ([405c9a2](https://github.com/sergeyshmakov/playwright-page-object/commit/405c9a2c3340ad21fe699e77513838bfcb3e1ef0))

## [2.1.1](https://github.com/sergeyshmakov/playwright-page-object/compare/v2.1.0...v2.1.1) (2026-08-14)


### Bug Fixes

* **mcp:** describe what the page-object tools can actually see ([#74](https://github.com/sergeyshmakov/playwright-page-object/issues/74)) ([2ebb94f](https://github.com/sergeyshmakov/playwright-page-object/commit/2ebb94f919ad4ce23af7b9e413ec10560d5d96d4))

# [2.1.0](https://github.com/sergeyshmakov/playwright-page-object/compare/v2.0.3...v2.1.0) (2026-08-13)


### Bug Fixes

* **deps:** bump zod from 4.2.0 to 4.4.3 in the npm-production group ([#72](https://github.com/sergeyshmakov/playwright-page-object/issues/72)) ([a342f32](https://github.com/sergeyshmakov/playwright-page-object/commit/a342f327c9d31ca872afab9c622838d0de54f94c))


### Features

* add MCP server for page-object and component analysis ([#70](https://github.com/sergeyshmakov/playwright-page-object/issues/70)) ([14cfb5d](https://github.com/sergeyshmakov/playwright-page-object/commit/14cfb5db4f8fcb8954f06b574d2e406ffc5595b6))

## [2.0.3](https://github.com/sergeyshmakov/playwright-page-object/compare/v2.0.2...v2.0.3) (2026-05-14)


### Bug Fixes

* restore node engines >=20 after accidental bump ([c683ef3](https://github.com/sergeyshmakov/playwright-page-object/commit/c683ef3c0bcd613f581b1d86a6477159b7254711))

## [2.0.2](https://github.com/sergeyshmakov/playwright-page-object/compare/v2.0.1...v2.0.2) (2026-05-13)


### Bug Fixes

* fix node eol in package.json ([c3c42f8](https://github.com/sergeyshmakov/playwright-page-object/commit/c3c42f8f3e40ad4b18dbffca2c01f2b86c0d207a))

## [2.0.1](https://github.com/sergeyshmakov/playwright-page-object/compare/v2.0.0...v2.0.1) (2026-05-13)


### Bug Fixes

* remove boundlesize from readme ([ef8960d](https://github.com/sergeyshmakov/playwright-page-object/commit/ef8960d1300949fba08b22904d85de2aa46df636))

# [2.0.0](https://github.com/sergeyshmakov/playwright-page-object/compare/v1.4.2...v2.0.0) (2026-05-13)


* chore!: repo polish ([e146bf8](https://github.com/sergeyshmakov/playwright-page-object/commit/e146bf845412d4cf75ad0f503149773611099b06))


### Bug Fixes

* include base PageObject in isClass guard ([399bf26](https://github.com/sergeyshmakov/playwright-page-object/commit/399bf261bc2c2b89cacecc0c01ad2c8d9379e424))


### BREAKING CHANGES

* ListStrictSelector removed; use Selector(id) for identical behavior.
* PageObject.waitProp, waitPropAbsence, waitNoValue removed; use .$.expect().
* ListPageObject.filterByTestId renamed to filterByItemTestId.
* ListPageObject.getItemByIdMask removed; use getItemByTestId(new RegExp(mask)).
* PageObject subclasses cannot be @Selector factory args; use accessor initializer.
* ListPageObject constructor now throws on invalid itemType.
