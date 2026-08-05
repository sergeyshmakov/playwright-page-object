import { Node } from "ts-morph";
import { describe, expect, it } from "vitest";
import {
	isInNodeModules,
	resolveClassRef,
	resolveIdentifier,
	resolvesToCallable,
} from "../../../analysis/util/resolve";
import { makeWorkspace, memoryPath } from "../helpers/inMemory";

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
