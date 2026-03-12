export {
	ListRootSelector,
	RootSelector,
	RootSelectorByAltText,
	RootSelectorByLabel,
	RootSelectorByPlaceholder,
	RootSelectorByRole,
	RootSelectorByText,
	RootSelectorByTitle,
} from "./decorators/rootSelectors";
export { SelectorBy } from "./decorators/selectorBy";
export {
	ListSelector,
	ListStrictSelector,
	Selector,
	SelectorByAltText,
	SelectorByLabel,
	SelectorByPlaceholder,
	SelectorByRole,
	SelectorByText,
	SelectorByTitle,
} from "./decorators/selectors";
export { createFixtures } from "./fixtures";
export { ListPageObject } from "./page-objects/ListPageObject";
export { PageObject } from "./page-objects/PageObject";

export type { PageObjectConstructor, SelectorType } from "./page-objects/PageObject";
export type { FixturesFromMap, PageObjectConstructorsMap } from "./fixtures";
