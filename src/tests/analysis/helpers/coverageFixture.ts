import { buildCoverageReport } from "../../../analysis/coverage/mapCoverage";
import { libImport, makeWorkspace } from "./inMemory";

export const UI = {
	"src/main.tsx": 'import App from "./App";\nexport const x = <App />;',
	"src/App.tsx": [
		"export default function App() {",
		"  return (",
		"    <main>",
		'      <input data-testid="PromoCodeInput" />',
		'      <button data-testid="ApplyPromoButton" />',
		'      <span data-testid="Orphan" />',
		"    </main>",
		"  );",
		"}",
	].join("\n"),
};

export const PAGE_OBJECT = {
	"e2e/HomePage.ts": [
		'import type { Locator } from "@playwright/test";',
		libImport("RootPageObject", "RootSelector", "Selector", "SelectorByRole"),
		"@RootSelector()",
		"export class HomePage extends RootPageObject {",
		'  @Selector("PromoCodeInput")',
		"  accessor Promo!: Locator;",
		'  @SelectorByRole("button", { name: "Apply" })',
		"  accessor Apply!: Locator;",
		'  @Selector("PromoCodeInpt")',
		"  accessor Typo!: Locator;",
		"  @Selector(dynamicId)",
		"  accessor Dyn!: Locator;",
		"}",
		"declare const dynamicId: string;",
	].join("\n"),
};

/** A template hole in fixture *source*, assembled so it is not one here. */
export const hole = (name: string): string => `\${${name}}`;

export function report(extra: Record<string, string> = {}, options = {}) {
	return buildCoverageReport(
		makeWorkspace({ ...UI, ...PAGE_OBJECT, ...extra }),
		options,
	);
}
