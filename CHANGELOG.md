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
