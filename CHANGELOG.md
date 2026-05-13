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
