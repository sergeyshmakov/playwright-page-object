import { afterAll, describe, expect, it } from "vitest";
import { closeAllClients, withProject } from "./helpers/mcpClient";

afterAll(closeAllClients);

describe("scoping coverage to a control class", () => {
	/**
	 * A factory-only control is filtered out of the default discovery index, but
	 * its class name is exactly what a parent's selector tree hands the caller.
	 * Asking for its coverage by the name the tree just showed answered
	 * `class_not_found` and recommended `list_page_objects`, which by design
	 * never lists it - while the same selectors were auditable by `file`.
	 */
	it("finds a control the default index filters out", async () => {
		await withProject(
			"ppo-control-scope-",
			{
				"tsconfig.json": JSON.stringify({
					compilerOptions: { target: "ES2022", jsx: "react-jsx", noEmit: true },
				}),
				"src/App.tsx": [
					"export default function App() {",
					'  return <div data-testid="Row" />;',
					"}",
					"",
				].join("\n"),
				// No decorators, no library base: discovered *only* because it appears
				// as a factory argument, which is exactly what the default index
				// filters out and what the class branch could not then find.
				"e2e/Row.ts": [
					"export class RowControl {",
					"  constructor(public locator: never) {}",
					"}",
					"",
				].join("\n"),
				"e2e/HomePage.ts": [
					'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
					'import { RowControl } from "./Row";',
					'@RootSelector("Root")',
					"export class HomePage extends RootPageObject {",
					'  @Selector("Row", (locator) => new RowControl(locator))',
					"  accessor Row!: RowControl;",
					"}",
					"",
				].join("\n"),
			},
			async (client) => {
				const result = await client.callTool({
					name: "map_coverage",
					arguments: { class: "RowControl", buckets: [] },
				});
				const text = (result.content as Array<{ text: string }>)[0].text;
				const parsed = JSON.parse(text);
				expect(parsed.ok, text).toBe(true);
			},
		);
	});
});
