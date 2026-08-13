import { libImport } from "./inMemory";

/**
 * The page-object sources both tree specs build their fixtures from.
 *
 * Shared rather than duplicated because the two files disagree about nothing
 * here: `SHARED` is one repository, and a change to it should move both specs
 * or neither.
 */

export const PRELUDE = [
	'import type { Locator } from "@playwright/test";',
	libImport(
		"ListPageObject",
		"ListSelector",
		"PageObject",
		"RootPageObject",
		"RootSelector",
		"Selector",
	),
].join("\n");

export const SHARED = {
	"e2e/Button.ts": [
		libImport("PageObject"),
		"export class Button extends PageObject {}",
	].join("\n"),
	"e2e/Row.ts": [
		PRELUDE,
		'import { Button } from "./Button";',
		"export class Row extends PageObject {",
		'  @Selector("remove")',
		"  accessor Remove = new Button();",
		"}",
	].join("\n"),
	"e2e/HomePage.ts": [
		PRELUDE,
		'import { Button } from "./Button";',
		'import { Row } from "./Row";',
		'@RootSelector("Home")',
		"export class HomePage extends RootPageObject {",
		'  @Selector("apply")',
		"  accessor Apply = new Button();",
		'  @ListSelector("Row_")',
		"  accessor Rows = new ListPageObject(Row);",
		"}",
	].join("\n"),
};
