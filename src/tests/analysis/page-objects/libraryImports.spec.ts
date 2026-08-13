import * as path from "node:path";
import { Project, ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import { discoverPageObjects } from "../../../analysis/page-objects/discover";
import {
	CANONICAL_EXPORTS,
	FIXED_ARITY_DECORATORS,
	LIBRARY_BASE_CLASSES,
	MEMBER_DECORATORS,
	ROOT_DECORATORS,
} from "../../../analysis/page-objects/libraryImports";
import { REPO_ROOT } from "../helpers/example";
import { makeWorkspace } from "../helpers/inMemory";

/**
 * The analyser's mirror of the library's public API, held to the real thing.
 *
 * `libraryImports.ts` hand-copies the names of every decorator and base class
 * `src/index.ts` exports, and those sets decide *what counts as a page object at
 * all*: `canonicalLocalName` resolves a local binding through them, and a name
 * missing from them resolves to nothing.
 *
 * That failure is silent and total. Add a decorator to the library, forget this
 * file, and a class using it disappears from `list_page_objects` and
 * `get_page_object_tree` — and, worse, drops out of the coverage denominator, so
 * the ids it selects are reported as uncovered rather than as unanalysed. No
 * error, no warning, just a smaller answer that looks complete.
 *
 * Read off the source syntactically rather than by importing `src/index.ts`,
 * for the same reason `no-runtime-import.spec.ts` does: a `type` re-export is
 * erased at runtime, so an import can only see the value exports, and the point
 * here is to notice a *new* name the moment it is written.
 */

/** Value (non-type) names `src/index.ts` re-exports. */
function publicValueExports(): Set<string> {
	const project = new Project({
		skipAddingFilesFromTsConfig: true,
		skipFileDependencyResolution: true,
		skipLoadingLibFiles: true,
		compilerOptions: { target: ts.ScriptTarget.ES2022, noEmit: true },
	});
	const entry = project.addSourceFileAtPath(
		path.join(REPO_ROOT, "src", "index.ts"),
	);
	const names = new Set<string>();
	for (const declaration of entry.getExportDeclarations()) {
		// `export type { … } from` contributes nothing at runtime, and the analyser
		// only ever matches value bindings written in user code.
		if (declaration.isTypeOnly()) {
			continue;
		}
		for (const specifier of declaration.getNamedExports()) {
			if (specifier.isTypeOnly()) {
				continue;
			}
			const alias = specifier.getAliasNode();
			names.add(alias ? alias.getText() : specifier.getName());
		}
	}
	return names;
}

const PUBLIC = publicValueExports();

describe("the analyser's mirror of the library API", () => {
	it("reads a public surface at all", () => {
		// Guards the guard: a refactor that moves `src/index.ts` or switches it to
		// `export *` would otherwise make every assertion below vacuously true.
		expect(PUBLIC.size).toBeGreaterThan(15);
		expect(PUBLIC).toContain("PageObject");
		expect(PUBLIC).toContain("Selector");
	});

	it("classifies exactly the names the library exports", () => {
		// Both directions in one assertion, which is the point: a name the library
		// gained and this file has not, and a name this file still lists after the
		// library dropped it.
		expect([...CANONICAL_EXPORTS].sort()).toEqual([...PUBLIC].sort());
	});

	it("sorts every export into exactly one bucket", () => {
		// `CANONICAL_EXPORTS` is a union, so the test above passes even if a name
		// landed in two buckets or in none of the three and only in the union.
		const buckets = [ROOT_DECORATORS, MEMBER_DECORATORS, LIBRARY_BASE_CLASSES];
		for (const name of PUBLIC) {
			// `createFixtures` is a function, not a decorator or a base class; it is
			// canonical without belonging to any of the three.
			if (name === "createFixtures") {
				continue;
			}
			const homes = buckets.filter((bucket) => bucket.has(name));
			expect(homes.length, `${name} should be in exactly one bucket`).toBe(1);
		}
	});

	it("keeps the arity split inside the member decorators", () => {
		// `FIXED_ARITY_DECORATORS` names the ones whose factory argument sits at a
		// known index; anything in it that is not a member decorator is a typo that
		// would otherwise change nothing and be invisible.
		for (const name of FIXED_ARITY_DECORATORS) {
			expect(MEMBER_DECORATORS.has(name), `${name} is a member decorator`).toBe(
				true,
			);
		}
	});
});

/**
 * Re-exporting the library through one project module is a normal convention:
 * `src/testing/pom.ts` does `export { Selector } from "playwright-page-object"`
 * and every page object imports from there. The specifier is relative, so none
 * of the names were recognised, the decorator map came back empty, and the
 * whole repository disappeared from `list_page_objects`, the trees and the
 * coverage denominator at once — with no diagnostic saying why.
 */
describe("the library reached through a project barrel", () => {
	it("finds a page object importing from a re-exporting barrel", () => {
		const discovery = discoverPageObjects(
			makeWorkspace({
				"e2e/pom.ts": [
					'export { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
				].join("\n"),
				"e2e/HomePage.ts": [
					'import { RootPageObject, RootSelector, Selector } from "./pom";',
					'@RootSelector("Root")',
					"export class HomePage extends RootPageObject {",
					'  @Selector("Title")',
					"  accessor Title!: never;",
					"}",
				].join("\n"),
			}),
		);
		const home = discovery.pageObjects.find(
			(one) => one.className === "HomePage",
		);
		expect(home).toBeDefined();
		expect(home?.counts.members).toBe(1);
	});

	it("follows a nested barrel and an outward alias on the import", () => {
		const discovery = discoverPageObjects(
			makeWorkspace({
				"e2e/inner.ts": 'export * from "playwright-page-object";',
				"e2e/pom.ts": 'export * from "./inner";',
				"e2e/HomePage.ts": [
					'import { RootPageObject, RootSelector, Selector as Sel } from "./pom";',
					'@RootSelector("Root")',
					"export class HomePage extends RootPageObject {",
					'  @Sel("Title")',
					"  accessor Title!: never;",
					"}",
				].join("\n"),
			}),
		);
		expect(
			discovery.pageObjects.find((one) => one.className === "HomePage")?.counts
				.members,
		).toBe(1);
	});

	it("follows the two-step import-then-export form", () => {
		const discovery = discoverPageObjects(
			makeWorkspace({
				"e2e/pom.ts": [
					'import { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
					"export { RootPageObject, RootSelector, Selector };",
				].join("\n"),
				"e2e/HomePage.ts": [
					'import { RootPageObject, RootSelector, Selector } from "./pom";',
					'@RootSelector("Root")',
					"export class HomePage extends RootPageObject {",
					'  @Selector("Title")',
					"  accessor Title!: never;",
					"}",
				].join("\n"),
			}),
		);
		expect(
			discovery.pageObjects.find((one) => one.className === "HomePage")?.counts
				.members,
		).toBe(1);
	});

	it("still ignores a relative import that reaches no library", () => {
		// The cheap name test admits `Selector` for resolution; the walk has to be
		// what rejects it, or every project type named `Selector` becomes ours.
		const discovery = discoverPageObjects(
			makeWorkspace({
				"e2e/pom.ts":
					"export const Selector = 1;\nexport class RootPageObject {}",
				"e2e/HomePage.ts": [
					'import { RootPageObject, Selector } from "./pom";',
					"export class HomePage extends RootPageObject {",
					'  @Selector("Title")',
					"  accessor Title!: never;",
					"}",
				].join("\n"),
			}),
		);
		expect(
			discovery.pageObjects.find((one) => one.className === "HomePage"),
		).toBeUndefined();
	});
});

describe("barrel shapes that must not be over-read", () => {
	it("does not treat `export * as ns` as a passthrough re-export", () => {
		// `export * as controls from "the-library"` publishes one name -
		// `controls` - and reading it as `export *` said the barrel re-exported
		// `Selector`, so the barrel's own local `Selector` became the library's.
		const discovery = discoverPageObjects(
			makeWorkspace({
				"e2e/pom.ts": [
					'export * as controls from "playwright-page-object";',
					"export const Selector = (id: string) => (..._args: never[]) => {};",
					"export class RootPageObject {}",
				].join("\n"),
				"e2e/HomePage.ts": [
					'import { RootPageObject, Selector } from "./pom";',
					"export class HomePage extends RootPageObject {",
					'  @Selector("Title")',
					"  accessor Title!: never;",
					"}",
				].join("\n"),
			}),
		);
		expect(
			discovery.pageObjects.find((one) => one.className === "HomePage"),
		).toBeUndefined();
	});

	it("resolves a namespace import of a barrel that reaches the library", () => {
		const discovery = discoverPageObjects(
			makeWorkspace({
				"e2e/pom.ts": 'export * from "playwright-page-object";',
				"e2e/HomePage.ts": [
					'import * as po from "./pom";',
					"@po.RootSelector()",
					"export class HomePage extends po.RootPageObject {",
					'  @po.Selector("Title")',
					"  accessor Title!: never;",
					"}",
				].join("\n"),
			}),
		);
		expect(
			discovery.pageObjects.find((one) => one.className === "HomePage")?.counts
				.members,
		).toBe(1);
	});

	it("leaves a namespace import of an unrelated module alone", () => {
		const discovery = discoverPageObjects(
			makeWorkspace({
				"e2e/pom.ts": "export class RootPageObject {}",
				"e2e/HomePage.ts": [
					'import * as po from "./pom";',
					"export class HomePage extends po.RootPageObject {}",
				].join("\n"),
			}),
		);
		expect(
			discovery.pageObjects.find((one) => one.className === "HomePage"),
		).toBeUndefined();
	});
});

describe("what a namespace import of a barrel is allowed to claim", () => {
	/**
	 * A boolean "does this barrel reach the library" made the whole namespace
	 * trusted, so a barrel that re-exports `PageObject` from the package while
	 * defining its own `Selector` had `po.Selector` read as the library's
	 * decorator. The project's own decorator was never seen, and the class was
	 * reported with members it does not have.
	 */
	it("does not claim a name the barrel defines itself", () => {
		const discovery = discoverPageObjects(
			makeWorkspace({
				"e2e/pom.ts": [
					'export { RootPageObject, RootSelector } from "playwright-page-object";',
					"export const Selector = (_id: string) => (..._a: never[]) => {};",
				].join("\n"),
				"e2e/HomePage.ts": [
					'import * as po from "./pom";',
					"@po.RootSelector()",
					"export class HomePage extends po.RootPageObject {",
					'  @po.Selector("Title")',
					"  accessor Title!: never;",
					"}",
				].join("\n"),
			}),
		);
		const home = discovery.pageObjects.find(
			(one) => one.className === "HomePage",
		);
		// The class is still found - `po.RootPageObject` and `po.RootSelector`
		// really are the library's - but the local `Selector` is not ours.
		expect(home).toBeDefined();
		expect(home?.counts.members).toBe(0);
	});

	it("still claims the names the barrel does take from the library", () => {
		const discovery = discoverPageObjects(
			makeWorkspace({
				"e2e/pom.ts": 'export * from "playwright-page-object";',
				"e2e/HomePage.ts": [
					'import * as po from "./pom";',
					"@po.RootSelector()",
					"export class HomePage extends po.RootPageObject {",
					'  @po.Selector("Title")',
					"  accessor Title!: never;",
					"}",
				].join("\n"),
			}),
		);
		expect(
			discovery.pageObjects.find((one) => one.className === "HomePage")?.counts
				.members,
		).toBe(1);
	});

	it("follows a chain of six barrels", () => {
		// `seen` is what makes the walk terminate, so the hop cap is a cost bound
		// and five of them cut a real chain off before its exports were read.
		const files: Record<string, string> = {
			"e2e/b5.ts": 'export * from "playwright-page-object";',
		};
		for (let level = 4; level >= 0; level -= 1) {
			files[`e2e/b${level}.ts`] = `export * from "./b${level + 1}";`;
		}
		files["e2e/HomePage.ts"] = [
			'import { RootPageObject, RootSelector, Selector } from "./b0";',
			'@RootSelector("Root")',
			"export class HomePage extends RootPageObject {",
			'  @Selector("Title")',
			"  accessor Title!: never;",
			"}",
		].join("\n");
		expect(
			discoverPageObjects(makeWorkspace(files)).pageObjects.find(
				(one) => one.className === "HomePage",
			)?.counts.members,
		).toBe(1);
	});
});

describe("several library names through one intermediate barrel", () => {
	/**
	 * The visited set was shared across sibling `through()` calls, so resolving
	 * the first name marked the intermediate module and every later name got an
	 * empty map back from it. One export survived and the rest vanished - a class
	 * whose decorator came second was reported with no members, or with no
	 * library base at all.
	 *
	 * The same defect this branch already fixed once, in `d6ef71c`, for the
	 * config reader's export walk. A visited *set* answers "have I been here",
	 * which is the wrong question when the answer itself is what the caller
	 * needs; a memo answers "what did I find here".
	 */
	it("keeps every name a barrel re-exports through one module", () => {
		const discovery = discoverPageObjects(
			makeWorkspace({
				"e2e/inner.ts":
					'export { RootPageObject, RootSelector, Selector } from "playwright-page-object";',
				"e2e/pom.ts":
					'export { RootPageObject, RootSelector, Selector } from "./inner";',
				"e2e/HomePage.ts": [
					'import { RootPageObject, RootSelector, Selector } from "./pom";',
					'@RootSelector("Root")',
					"export class HomePage extends RootPageObject {",
					'  @Selector("Title")',
					"  accessor Title!: never;",
					'  @Selector("Body")',
					"  accessor Body!: never;",
					"}",
				].join("\n"),
			}),
		);
		const home = discovery.pageObjects.find(
			(one) => one.className === "HomePage",
		);
		expect(home, "the base class comes through the same barrel").toBeDefined();
		expect(home?.counts.members).toBe(2);
	});

	it("terminates on barrels that re-export each other", () => {
		const discovery = discoverPageObjects(
			makeWorkspace({
				"e2e/a.ts": 'export * from "./b";',
				"e2e/b.ts": 'export * from "./a";',
				"e2e/HomePage.ts": [
					'import { RootPageObject } from "./a";',
					"export class HomePage extends RootPageObject {}",
				].join("\n"),
			}),
		);
		expect(
			discovery.pageObjects.find((one) => one.className === "HomePage"),
		).toBeUndefined();
	});
});
