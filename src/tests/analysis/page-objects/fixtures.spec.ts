import { describe, expect, it } from "vitest";
import { readFixtureMaps } from "../../../analysis/page-objects/fixtures";
import { createAnalysisContext } from "../../../analysis/page-objects/libraryImports";
import { libImport, makeWorkspace } from "../helpers/inMemory";

const PAGE_FILES = {
	"src/HomePage.ts": [
		libImport("RootPageObject", "RootSelector"),
		'@RootSelector("Home")',
		"export class HomePage extends RootPageObject {}",
	].join("\n"),
	"src/AuthPage.ts": [
		libImport("RootPageObject", "RootSelector"),
		'@RootSelector("Auth")',
		"export class AuthPage extends RootPageObject {}",
	].join("\n"),
};

function readFixtures(files: Record<string, string>) {
	const ws = makeWorkspace({ ...PAGE_FILES, ...files });
	const ctx = createAnalysisContext(ws);
	return readFixtureMaps(ws.sourceFiles(), ctx);
}

describe("readFixtureMaps", () => {
	it("reads the constructor form", () => {
		const map = readFixtures({
			"src/fixtures.ts": [
				libImport("createFixtures"),
				'import { HomePage } from "./HomePage";',
				"export const fixtures = createFixtures({ homePage: HomePage });",
			].join("\n"),
		});
		expect(map.byName.get("homePage")).toBe("src/homepage.ts#homepage");
		const bindings = map.byClass.get("src/homepage.ts#homepage");
		expect(bindings).toHaveLength(1);
		expect(bindings?.[0]).toMatchObject({
			name: "homePage",
			form: "constructor",
			file: "src/fixtures.ts",
		});
	});

	it("reads the arrow-factory form and the class it constructs", () => {
		const map = readFixtures({
			"src/fixtures.ts": [
				libImport("createFixtures"),
				'import { AuthPage } from "./AuthPage";',
				"export const fixtures = createFixtures({",
				"  authPage: (page) => new AuthPage(page, { retries: 2 }),",
				"});",
			].join("\n"),
		});
		const bindings = map.byClass.get("src/authpage.ts#authpage");
		expect(bindings?.[0]).toMatchObject({
			name: "authPage",
			form: "factory",
		});
	});

	it("handles a mixed map", () => {
		const map = readFixtures({
			"src/fixtures.ts": [
				libImport("createFixtures"),
				'import { AuthPage } from "./AuthPage";',
				'import { HomePage } from "./HomePage";',
				"export const fixtures = createFixtures({",
				"  homePage: HomePage,",
				"  authPage: (page) => new AuthPage(page),",
				"});",
			].join("\n"),
		});
		expect([...map.byName.keys()].sort()).toEqual(["authPage", "homePage"]);
	});

	it("records two names bound to the same class as two bindings", () => {
		const map = readFixtures({
			"src/fixtures.ts": [
				libImport("createFixtures"),
				'import { HomePage } from "./HomePage";',
				"export const a = createFixtures({ homePage: HomePage });",
				"export const b = createFixtures({ landing: HomePage });",
			].join("\n"),
		});
		expect(map.byClass.get("src/homepage.ts#homepage")).toHaveLength(2);
	});

	it("reports a non-literal argument instead of guessing", () => {
		const map = readFixtures({
			"src/fixtures.ts": [
				libImport("createFixtures"),
				"const table = {};",
				"export const fixtures = createFixtures(table);",
			].join("\n"),
		});
		expect(map.byName.size).toBe(0);
		expect(map.warnings[0]?.code).toBe("fixtures-argument-dynamic");
	});

	it("reports an entry that is not a class reference", () => {
		const map = readFixtures({
			"src/fixtures.ts": [
				libImport("createFixtures"),
				"export const fixtures = createFixtures({ weird: 42 });",
			].join("\n"),
		});
		expect(map.byName.size).toBe(0);
		expect(map.warnings[0]?.code).toBe("fixture-entry-dynamic");
	});

	it("follows an aliased createFixtures import", () => {
		const map = readFixtures({
			"src/fixtures.ts": [
				'import { createFixtures as cf } from "playwright-page-object";',
				'import { HomePage } from "./HomePage";',
				"export const fixtures = cf({ homePage: HomePage });",
			].join("\n"),
		});
		expect(map.byName.get("homePage")).toBeDefined();
	});

	it("ignores a createFixtures that is not the library's", () => {
		const map = readFixtures({
			"src/other.ts":
				"export function createFixtures(_x: unknown) { return _x; }",
			"src/fixtures.ts": [
				'import { createFixtures } from "./other";',
				'import { HomePage } from "./HomePage";',
				"export const fixtures = createFixtures({ homePage: HomePage });",
			].join("\n"),
		});
		expect(map.byName.size).toBe(0);
	});
});
