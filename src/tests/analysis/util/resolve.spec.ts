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
