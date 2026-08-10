import { Node } from "ts-morph";
import { describe, expect, it } from "vitest";
import {
	isInNodeModules,
	resolveClassRef,
	resolveIdentifier,
	resolvesToCallable,
} from "../../../analysis/util/resolve";
import {
	MEMORY_ROOT_POSIX,
	makeWorkspace,
	memoryPath,
} from "../helpers/inMemory";

function resolveIn(
	files: Record<string, string>,
	fromFile: string,
	name: string,
) {
	const ws = makeWorkspace(files);
	const sourceFile = ws.project.getSourceFileOrThrow(memoryPath(fromFile));
	return resolveIdentifier(ws.project, sourceFile, name);
}

describe("resolveIdentifier", () => {
	it("finds a class declared in the same file", () => {
		const result = resolveIn(
			{ "src/a.ts": "export class Widget {}" },
			"src/a.ts",
			"Widget",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(Node.isClassDeclaration(result.declaration)).toBe(true);
			expect(result.kind).toBe("class");
		}
	});

	it("follows a named import through a relative specifier", () => {
		const result = resolveIn(
			{
				"src/a.ts": 'import { Widget } from "./widget";\nconst x = Widget;',
				"src/widget.ts": "export class Widget {}",
			},
			"src/a.ts",
			"Widget",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.sourceFile.getBaseName()).toBe("widget.ts");
		}
	});

	it("follows an aliased import back to the exported name", () => {
		const result = resolveIn(
			{
				"src/a.ts": 'import { Widget as W } from "./widget";',
				"src/widget.ts": "export class Widget {}",
			},
			"src/a.ts",
			"W",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.sourceFile.getBaseName()).toBe("widget.ts");
		}
	});

	it("follows a default import", () => {
		const result = resolveIn(
			{
				"src/a.ts": 'import Card from "./card";',
				"src/card.tsx": "export default function Card() { return null; }",
			},
			"src/a.ts",
			"Card",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.sourceFile.getBaseName()).toBe("card.tsx");
		}
	});

	it("follows `export { X } from` one hop", () => {
		const result = resolveIn(
			{
				"src/a.ts": 'import { Widget } from "./barrel";',
				"src/barrel.ts": 'export { Widget } from "./widget";',
				"src/widget.ts": "export class Widget {}",
			},
			"src/a.ts",
			"Widget",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.sourceFile.getBaseName()).toBe("widget.ts");
		}
	});

	it("follows `export * from` one hop", () => {
		const result = resolveIn(
			{
				"src/a.ts": 'import { Widget } from "./barrel";',
				"src/barrel.ts": 'export * from "./widget";',
				"src/widget.ts": "export class Widget {}",
			},
			"src/a.ts",
			"Widget",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.sourceFile.getBaseName()).toBe("widget.ts");
		}
	});

	it("follows a barrel that re-exports a local import", () => {
		const result = resolveIn(
			{
				"src/a.ts": 'import { Card } from "./barrel";',
				"src/barrel.ts": 'import { Card } from "./card";\nexport { Card };',
				"src/card.ts": "export class Card {}",
			},
			"src/a.ts",
			"Card",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.sourceFile.getBaseName()).toBe("card.ts");
		}
	});

	// `export { Card as CheckoutCard }` renames a declaration that lives in this
	// same file. The lookup ran the alias through the local-declaration check
	// (which cannot match, the declaration carries the pre-alias name) and then
	// searched for an *import* binding called `Card` — of which there is none.
	// The class was reported unresolved, which turns a static control reference
	// into a dynamic one and an imported component into a tree boundary.
	it("resolves an aliased export of a locally declared class", () => {
		const result = resolveIn(
			{
				"src/a.ts": 'import { CheckoutCard } from "./card";',
				"src/card.ts": "class Card {}\nexport { Card as CheckoutCard };",
			},
			"src/a.ts",
			"CheckoutCard",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.kind).toBe("class");
			// The declared name, not the importer's alias.
			expect(result.name).toBe("Card");
			expect(result.sourceFile.getBaseName()).toBe("card.ts");
		}
	});

	it("resolves an aliased export of a locally declared function", () => {
		const result = resolveIn(
			{
				"src/a.ts": 'import { makeCart } from "./cart";',
				"src/cart.ts": "function build() {}\nexport { build as makeCart };",
			},
			"src/a.ts",
			"makeCart",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.kind).toBe("function");
			expect(result.name).toBe("build");
		}
	});

	// The alias hop must not swallow the barrel case it was written for: when the
	// pre-alias name is an imported binding rather than a local declaration, the
	// import path still has to run.
	it("still follows an aliased re-export of an imported binding", () => {
		const result = resolveIn(
			{
				"src/a.ts": 'import { CheckoutCard } from "./barrel";',
				"src/barrel.ts":
					'import { Card } from "./card";\nexport { Card as CheckoutCard };',
				"src/card.ts": "export class Card {}",
			},
			"src/a.ts",
			"CheckoutCard",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.sourceFile.getBaseName()).toBe("card.ts");
		}
	});

	it("follows `export { default } from` without an alias", () => {
		const result = resolveIn(
			{
				"src/a.ts": 'import Card from "./barrel";',
				"src/barrel.ts": 'export { default } from "./card";',
				"src/card.tsx": "export default function Card() { return null; }",
			},
			"src/a.ts",
			"Card",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.sourceFile.getBaseName()).toBe("card.tsx");
		}
	});

	// `export { Card as default }` in a barrel names an *imported* binding, not a
	// declaration in the barrel. Searching only the barrel left every default
	// import of it unresolved, which stops a component walk at a boundary and
	// turns a page-object control reference dynamic.
	it("follows `export { X as default }` back through the barrel's import", () => {
		const result = resolveIn(
			{
				"src/a.ts": 'import Card from "./barrel";',
				"src/barrel.ts":
					'import { Card } from "./card";\nexport { Card as default };',
				"src/card.tsx": "export function Card() { return null; }",
			},
			"src/a.ts",
			"Card",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.name).toBe("Card");
			expect(result.sourceFile.getBaseName()).toBe("card.tsx");
		}
	});

	it("still rejects `export { default as Other }` as the default export", () => {
		const result = resolveIn(
			{
				"src/a.ts": 'import Card from "./barrel";',
				"src/barrel.ts": 'export { default as Other } from "./card";',
				"src/card.tsx": "const Card = 1;",
			},
			"src/a.ts",
			"Card",
		);
		expect(result.resolved).toBe(false);
	});

	it("resolves a directly default-exported arrow component", () => {
		const result = resolveIn(
			{
				"src/a.ts": 'import Card from "./card";',
				"src/card.tsx": "export default () => null;",
			},
			"src/a.ts",
			"Card",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.kind).toBe("function");
			expect(Node.isArrowFunction(result.declaration)).toBe(true);
		}
	});

	it("resolves a member of a relative namespace import", () => {
		const result = resolveIn(
			{
				"src/a.ts": 'import * as pages from "./pages";',
				"src/pages.ts": "export class HomePage {}",
			},
			"src/a.ts",
			"pages.HomePage",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.name).toBe("HomePage");
			expect(result.sourceFile.getBaseName()).toBe("pages.ts");
		}
	});

	it("resolves a nested namespace chain through `export * as`", () => {
		const result = resolveIn(
			{
				"src/a.ts": 'import * as pages from "./pages";',
				"src/pages.ts": 'export * as controls from "./controls";',
				"src/controls.ts": "export class Button {}",
			},
			"src/a.ts",
			"pages.controls.Button",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.name).toBe("Button");
			expect(result.sourceFile.getBaseName()).toBe("controls.ts");
		}
	});

	it("resolves a member of a nested `namespace` declaration", () => {
		const result = resolveIn(
			{
				"src/a.ts": 'import * as pages from "./pages";',
				"src/pages.ts": "export namespace controls { export class Button {} }",
			},
			"src/a.ts",
			"pages.controls.Button",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.name).toBe("Button");
		}
	});

	// Reporting an unwalkable chain as unsupported keeps it visible; the previous
	// silent `null` ref simply dropped the member out of the expanded graph.
	it("reports a chain it cannot walk as unsupported syntax", () => {
		const result = resolveIn(
			{
				"src/a.ts": 'import * as pages from "./pages";',
				"src/pages.ts": "export const controls = { Button: class {} };",
			},
			"src/a.ts",
			"pages.controls.Button",
		);
		expect(result.resolved).toBe(false);
		if (!result.resolved && !result.external) {
			expect(result.reason).toBe("unsupported-syntax");
		}
	});

	it("reports a member of a bare-specifier namespace as external", () => {
		const result = resolveIn(
			{ "src/a.ts": 'import * as po from "playwright-page-object";' },
			"src/a.ts",
			"po.PageObject",
		);
		expect(result.resolved).toBe(false);
		if (!result.resolved && result.external) {
			expect(result.module).toBe("playwright-page-object");
			expect(result.name).toBe("PageObject");
		}
	});

	it("resolves an `index.ts` directory specifier", () => {
		const result = resolveIn(
			{
				"src/a.ts": 'import { Widget } from "./controls";',
				"src/controls/index.ts": "export class Widget {}",
			},
			"src/a.ts",
			"Widget",
		);
		expect(result.resolved).toBe(true);
	});

	it("reports a bare specifier as external without touching node_modules", () => {
		const result = resolveIn(
			{ "src/a.ts": 'import { PageObject } from "playwright-page-object";' },
			"src/a.ts",
			"PageObject",
		);
		expect(result.resolved).toBe(false);
		if (!result.resolved && result.external) {
			expect(result.module).toBe("playwright-page-object");
			expect(result.name).toBe("PageObject");
		}
	});

	it("reports an unknown identifier as unresolved rather than throwing", () => {
		const result = resolveIn(
			{ "src/a.ts": "const x = 1;" },
			"src/a.ts",
			"Nope",
		);
		expect(result.resolved).toBe(false);
		if (!result.resolved && !result.external) {
			expect(result.reason).toBe("identifier-unresolved");
		}
	});
});

describe("resolveIdentifier through tsconfig paths", () => {
	/** In-memory workspace whose compiler options carry a `paths` table. */
	function resolveAliased(
		files: Record<string, string>,
		paths: Record<string, string[]>,
		name: string,
		fromFile = "src/a.ts",
	) {
		const ws = makeWorkspace(files);
		ws.project.compilerOptions.set({ baseUrl: MEMORY_ROOT_POSIX, paths });
		const sourceFile = ws.project.getSourceFileOrThrow(memoryPath(fromFile));
		return resolveIdentifier(ws.project, sourceFile, name);
	}

	it("follows a `@/*` alias instead of declaring it external", () => {
		const result = resolveAliased(
			{
				"src/a.ts": 'import { Cart } from "@/components/Cart";',
				"src/components/Cart.ts": "export class Cart {}",
			},
			{ "@/*": ["src/*"] },
			"Cart",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.sourceFile.getBaseName()).toBe("Cart.ts");
		}
	});

	it("follows an exact (star-free) alias", () => {
		const result = resolveAliased(
			{
				"src/a.ts": 'import { Cart } from "~cart";',
				"src/components/Cart.ts": "export class Cart {}",
			},
			{ "~cart": ["src/components/Cart.ts"] },
			"Cart",
		);
		expect(result.resolved).toBe(true);
	});

	it("prefers the longest matching pattern, as TypeScript does", () => {
		const result = resolveAliased(
			{
				"src/a.ts": 'import { Cart } from "@/components/Cart";',
				"src/components/Cart.ts": "export class Cart {}",
				"other/components/Cart.ts": "export class Cart {}",
			},
			{ "@/*": ["other/*"], "@/components/*": ["src/components/*"] },
			"Cart",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.sourceFile.getDirectoryPath()).toContain("/src/components");
		}
	});

	it("resolves a namespace import written through an alias", () => {
		const result = resolveAliased(
			{
				"src/a.ts": 'import * as pages from "@/pages";',
				"src/pages.ts": "export class HomePage {}",
			},
			{ "@/*": ["src/*"] },
			"pages.HomePage",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.name).toBe("HomePage");
		}
	});

	it("keeps an alias that lands in node_modules external", () => {
		const result = resolveAliased(
			{
				"src/a.ts": 'import { Cart } from "@ui/Cart";',
				"node_modules/@acme/ui/Cart.ts": "export class Cart {}",
			},
			{ "@ui/*": ["node_modules/@acme/ui/*"] },
			"Cart",
		);
		expect(result.resolved).toBe(false);
		if (!result.resolved) {
			expect(result.external).toBe(true);
		}
	});

	// Rejecting the dependency only after loading it still parsed it into the
	// project: the file has to stay unread, which is what lets the engine work on
	// a repository that was never `npm install`ed.
	it("never parses an alias target inside node_modules", () => {
		const ws = makeWorkspace({
			"src/a.ts": 'import { Cart } from "@ui/Cart";',
		});
		const dependency = memoryPath("node_modules/@acme/ui/Cart.ts");
		ws.project
			.getFileSystem()
			.writeFileSync(dependency, "export class Cart {}");
		ws.project.compilerOptions.set({
			baseUrl: MEMORY_ROOT_POSIX,
			paths: { "@ui/*": ["node_modules/@acme/ui/*"] },
		});
		const sourceFile = ws.project.getSourceFileOrThrow(memoryPath("src/a.ts"));

		const result = resolveIdentifier(ws.project, sourceFile, "Cart");
		expect(result.resolved).toBe(false);
		expect(ws.project.getSourceFile(dependency)).toBeUndefined();
	});

	it("does not fall through to a less specific pattern when the best one misses", () => {
		const result = resolveAliased(
			{
				"src/a.ts": 'import { Cart } from "@/components/Cart";',
				// Only the catch-all's target exists; TypeScript would still commit to
				// `@/components/*` and report the import unresolved.
				"other/components/Cart.ts": "export class Cart {}",
			},
			{ "@/*": ["other/*"], "@/components/*": ["src/components/*"] },
			"Cart",
		);
		expect(result.resolved).toBe(false);
	});

	it("ignores a pattern with more than one `*`, as tsc does", () => {
		const result = resolveAliased(
			{
				"src/a.ts": 'import { Cart } from "@/components/Cart";',
				"src/components/Cart.ts": "export class Cart {}",
			},
			{ "@/*/*": ["src/*"] },
			"Cart",
		);
		expect(result.resolved).toBe(false);
	});

	it("substitutes into a target that carries the only `*`", () => {
		const result = resolveAliased(
			{
				"src/a.ts": 'import { Cart } from "#c/Cart";',
				"src/components/Cart.ts": "export class Cart {}",
			},
			{ "#c/*": ["src/components/*"] },
			"Cart",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.sourceFile.getBaseName()).toBe("Cart.ts");
		}
	});

	it("still reports an unmapped bare specifier as external", () => {
		const result = resolveAliased(
			{
				"src/a.ts": 'import { PageObject } from "playwright-page-object";',
				"src/components/Cart.ts": "export class Cart {}",
			},
			{ "@/*": ["src/*"] },
			"PageObject",
		);
		expect(result.resolved).toBe(false);
		if (!result.resolved && result.external) {
			expect(result.module).toBe("playwright-page-object");
		}
	});

	it("follows a barrel re-export written through an alias", () => {
		const result = resolveAliased(
			{
				"src/a.ts": 'import { Widget } from "@/barrel";',
				"src/barrel.ts": 'export { Widget } from "@/widget";',
				"src/widget.ts": "export class Widget {}",
			},
			{ "@/*": ["src/*"] },
			"Widget",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.sourceFile.getBaseName()).toBe("widget.ts");
		}
	});
});

describe("resolveIdentifier through baseUrl", () => {
	/** A `baseUrl` with no `paths` table: bare specifiers are local imports. */
	function resolveUnderBaseUrl(files: Record<string, string>, name: string) {
		const ws = makeWorkspace(files);
		ws.project.compilerOptions.set({ baseUrl: `${MEMORY_ROOT_POSIX}/src` });
		const sourceFile = ws.project.getSourceFileOrThrow(memoryPath("src/a.ts"));
		return resolveIdentifier(ws.project, sourceFile, name);
	}

	it("resolves a bare specifier against baseUrl without any paths entry", () => {
		const result = resolveUnderBaseUrl(
			{
				"src/a.ts": 'import { Cart } from "components/Cart";',
				"src/components/Cart.ts": "export class Cart {}",
			},
			"Cart",
		);
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.sourceFile.getBaseName()).toBe("Cart.ts");
		}
	});

	it("resolves a baseUrl directory import through its index file", () => {
		const result = resolveUnderBaseUrl(
			{
				"src/a.ts": 'import { Cart } from "components";',
				"src/components/index.ts": "export class Cart {}",
			},
			"Cart",
		);
		expect(result.resolved).toBe(true);
	});

	it("still reports a real dependency as external", () => {
		const result = resolveUnderBaseUrl(
			{ "src/a.ts": 'import { PageObject } from "playwright-page-object";' },
			"PageObject",
		);
		expect(result.resolved).toBe(false);
		if (!result.resolved && result.external) {
			expect(result.module).toBe("playwright-page-object");
		}
	});
});

describe("resolveClassRef", () => {
	it("keeps a class expression assigned to a const", () => {
		const ws = makeWorkspace({ "src/a.ts": "const Widget = class {};" });
		const sourceFile = ws.project.getSourceFileOrThrow(memoryPath("src/a.ts"));
		const result = resolveClassRef(ws.project, sourceFile, "Widget");
		expect(result.resolved).toBe(true);
		if (result.resolved) {
			expect(result.kind).toBe("class");
		}
	});
});

describe("resolvesToCallable", () => {
	it("accepts classes, functions and function-valued consts", () => {
		const ws = makeWorkspace({
			"src/a.ts": [
				"export class C {}",
				"export function f() {}",
				"export const arrow = () => 1;",
				"export const num = 1;",
			].join("\n"),
		});
		const sourceFile = ws.project.getSourceFileOrThrow(memoryPath("src/a.ts"));
		const check = (name: string) =>
			resolvesToCallable(resolveIdentifier(ws.project, sourceFile, name));
		expect(check("C")).toBe(true);
		expect(check("f")).toBe(true);
		expect(check("arrow")).toBe(true);
		expect(check("num")).toBe(false);
	});
});

describe("isInNodeModules", () => {
	it("detects dependency paths on both separators", () => {
		expect(isInNodeModules("/repo/node_modules/x/index.d.ts")).toBe(true);
		expect(isInNodeModules("C:\\repo\\node_modules\\x\\index.d.ts")).toBe(true);
		expect(isInNodeModules("/repo/src/index.ts")).toBe(false);
	});
});
