import { describe, expect, it } from "vitest";
import { readFixtureMaps } from "../../../analysis/page-objects/fixtures";
import { createAnalysisContext } from "../../../analysis/page-objects/libraryImports";
import { keyFold } from "../../../analysis/util/paths";
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
		expect(map.byName.get("homePage")).toBe(
			keyFold("src/HomePage.ts#HomePage"),
		);
		const bindings = map.byClass.get(keyFold("src/HomePage.ts#HomePage"));
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
		const bindings = map.byClass.get(keyFold("src/AuthPage.ts#AuthPage"));
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
		expect(map.byClass.get(keyFold("src/HomePage.ts#HomePage"))).toHaveLength(
			2,
		);
	});

	it("binds a multi-statement factory to the class it returns", () => {
		const map = readFixtures({
			"src/helper.ts": "export class Helper {}",
			"src/fixtures.ts": [
				libImport("createFixtures"),
				'import { AuthPage } from "./AuthPage";',
				'import { Helper } from "./helper";',
				"export const fixtures = createFixtures({",
				"  authPage: (page) => {",
				"    const helper = new Helper();",
				"    return new AuthPage(page, helper);",
				"  },",
				"});",
			].join("\n"),
		});
		expect(map.byName.get("authPage")).toBe(
			keyFold("src/AuthPage.ts#AuthPage"),
		);
		expect(map.byClass.has(keyFold("src/helper.ts#Helper"))).toBe(false);
	});

	it("follows a returned local one hop to its constructor", () => {
		const map = readFixtures({
			"src/fixtures.ts": [
				libImport("createFixtures"),
				'import { HomePage } from "./HomePage";',
				"export const fixtures = createFixtures({",
				"  homePage: (page) => {",
				"    const home = new HomePage(page);",
				"    return home;",
				"  },",
				"});",
			].join("\n"),
		});
		expect(map.byName.get("homePage")).toBe(
			keyFold("src/HomePage.ts#HomePage"),
		);
	});

	// `getDescendantsOfKind` finds document order, not scope. The nested helper's
	// `result` is out of scope at the factory's return, but it was matched first
	// and the fixture came out bound to a class the factory never returns —
	// silently, with no warning to say the answer was a guess.
	it("ignores a same-named local declared inside a nested helper", () => {
		const map = readFixtures({
			"src/other.ts": "export class OtherPage {}",
			"src/fixtures.ts": [
				libImport("createFixtures"),
				'import { HomePage } from "./HomePage";',
				'import { OtherPage } from "./other";',
				"export const fixtures = createFixtures({",
				"  homePage: (page) => {",
				"    function helper() { const result = new OtherPage(); return result; }",
				"    void helper;",
				"    const result = new HomePage(page);",
				"    return result;",
				"  },",
				"});",
			].join("\n"),
		});
		expect(map.byName.get("homePage")).toBe(
			keyFold("src/HomePage.ts#HomePage"),
		);
		expect(map.byClass.has(keyFold("src/other.ts#OtherPage"))).toBe(false);
	});

	it("follows an entry that names a factory declared beside it", () => {
		const map = readFixtures({
			"src/fixtures.ts": [
				libImport("createFixtures"),
				'import { HomePage } from "./HomePage";',
				"const makeHome = (page) => new HomePage(page);",
				"export const fixtures = createFixtures({ home: makeHome });",
			].join("\n"),
		});
		expect(map.byName.get("home")).toBe(keyFold("src/HomePage.ts#HomePage"));
		expect(
			map.byClass.get(keyFold("src/HomePage.ts#HomePage"))?.[0],
		).toMatchObject({ name: "home", form: "factory" });
	});

	it("follows the shorthand form of a named factory", () => {
		const map = readFixtures({
			"src/fixtures.ts": [
				libImport("createFixtures"),
				'import { HomePage } from "./HomePage";',
				"function makeHome(page) { return new HomePage(page); }",
				"export const fixtures = createFixtures({ makeHome });",
			].join("\n"),
		});
		expect(map.byName.get("makeHome")).toBe(
			keyFold("src/HomePage.ts#HomePage"),
		);
	});

	// An enclosure test is not lexical scope. An outer `const result` and an
	// inner block's `const result` both enclose the return, so document order
	// still picked the outer one — the same wrong class the enclosure test was
	// added to prevent, one nesting level down. Nearest binding wins.
	it("resolves a returned local to the nearest enclosing declaration", () => {
		const map = readFixtures({
			"src/other.ts": "export class OtherPage {}",
			"src/fixtures.ts": [
				libImport("createFixtures"),
				'import { HomePage } from "./HomePage";',
				'import { OtherPage } from "./other";',
				"export const fixtures = createFixtures({",
				"  home: (page) => {",
				"    const result = new OtherPage();",
				"    void result;",
				"    { const result = new HomePage(page); return result; }",
				"  },",
				"});",
			].join("\n"),
		});
		expect(map.byName.get("home")).toBe(keyFold("src/HomePage.ts#HomePage"));
		expect(map.byClass.has(keyFold("src/other.ts#OtherPage"))).toBe(false);
	});

	it("reads the factory the call site names, not a module-level namesake", () => {
		const map = readFixtures({
			"src/other.ts": "export class OtherPage {}",
			"src/fixtures.ts": [
				libImport("createFixtures"),
				'import { HomePage } from "./HomePage";',
				'import { OtherPage } from "./other";',
				"const makeHome = () => new OtherPage();",
				"export function build() {",
				"  const makeHome = (page) => new HomePage(page);",
				"  return createFixtures({ home: makeHome });",
				"}",
				"void makeHome;",
			].join("\n"),
		});
		expect(map.byName.get("home")).toBe(keyFold("src/HomePage.ts#HomePage"));
	});

	it("follows a named factory that exists only inside a function", () => {
		const map = readFixtures({
			"src/fixtures.ts": [
				libImport("createFixtures"),
				'import { HomePage } from "./HomePage";',
				"export function build() {",
				"  const makeHome = (page) => new HomePage(page);",
				"  return createFixtures({ home: makeHome });",
				"}",
			].join("\n"),
		});
		expect(map.byName.get("home")).toBe(keyFold("src/HomePage.ts#HomePage"));
	});

	// This had its own unwrapping, which knew parentheses and nothing else, so a
	// perfectly static factory was reported `fixture-entry-dynamic` — dropping
	// the metadata and any class whose only discovery evidence was that fixture.
	it.each([
		["an as-expression", "new HomePage(page) as HomePage"],
		["a satisfies-expression", "new HomePage(page) satisfies HomePage"],
		["a non-null assertion", "new HomePage(page)!"],
	])("follows a factory returning %s", (_label, expression) => {
		const map = readFixtures({
			"src/fixtures.ts": [
				libImport("createFixtures"),
				'import { HomePage } from "./HomePage";',
				`export const fixtures = createFixtures({ home: (page) => ${expression} });`,
			].join("\n"),
		});
		expect(map.byName.get("home")).toBe(keyFold("src/HomePage.ts#HomePage"));
	});

	it("resolves a constructor reached through a namespace import", () => {
		const map = readFixtures({
			"src/pages.ts": 'export { HomePage } from "./HomePage";',
			"src/fixtures.ts": [
				libImport("createFixtures"),
				'import * as pages from "./pages";',
				"export const fixtures = createFixtures({",
				"  homePage: (page) => new pages.HomePage(page),",
				"});",
			].join("\n"),
		});
		expect(map.byName.get("homePage")).toBe(
			keyFold("src/HomePage.ts#HomePage"),
		);
	});

	it("does not key a binding under an alias with no class declaration", () => {
		const map = readFixtures({
			"src/fixtures.ts": [
				libImport("createFixtures"),
				'import { HomePage } from "./HomePage";',
				"const Alias = HomePage;",
				"export const fixtures = createFixtures({ homePage: Alias });",
			].join("\n"),
		});
		expect(map.byName.has("homePage")).toBe(false);
		expect(map.byClass.has(keyFold("src/fixtures.ts#Alias"))).toBe(false);
		expect(map.warnings.map((diagnostic) => diagnostic.code)).toContain(
			"fixture-entry-dynamic",
		);
	});

	it("reports one fixture name bound to two different page objects", () => {
		const map = readFixtures({
			"src/fixtures.ts": [
				libImport("createFixtures"),
				'import { AuthPage } from "./AuthPage";',
				'import { HomePage } from "./HomePage";',
				"export const a = createFixtures({ page: HomePage });",
				"export const b = createFixtures({ page: AuthPage });",
			].join("\n"),
		});
		expect(map.warnings.map((diagnostic) => diagnostic.code)).toContain(
			"fixture-name-ambiguous",
		);
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
