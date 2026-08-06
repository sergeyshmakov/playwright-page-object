import { describe, expect, it } from "vitest";
import { runDiscovery } from "../../../analysis/page-objects/discover";
import type { Diagnostic } from "../../../analysis/types";
import { libImport, makeWorkspace } from "../helpers/inMemory";

function warningsFor(files: Record<string, string>): Diagnostic[] {
	const ws = makeWorkspace(files);
	const discovery = runDiscovery(ws);
	const out: Diagnostic[] = [...discovery.index.warnings];
	for (const summary of discovery.index.pageObjects) {
		out.push(...summary.warnings);
	}
	for (const entry of discovery.classes.values()) {
		out.push(...entry.warnings);
	}
	return out;
}

const codes = (diagnostics: Diagnostic[]) =>
	diagnostics.map((diagnostic) => diagnostic.code);

/**
 * Every payload now seeds itself with the workspace's environment warnings, and
 * an in-memory fixture has neither a Playwright config nor a JSX file — so those
 * two ship with every result here. They are not per-class diagnostics, which is
 * what this file is about.
 */
const ENVIRONMENT_CODES = new Set([
	"playwright-config-not-found",
	"scope-empty",
	"no-tsconfig",
]);

const PRELUDE = 'import type { Locator, Page } from "@playwright/test";\n';

describe("per-class diagnostics", () => {
	it("flags a selector decorator on a plain field", () => {
		const warnings = warningsFor({
			"src/a.ts": [
				PRELUDE,
				libImport("PageObject", "Selector"),
				"export class Host extends PageObject {",
				'  @Selector("x")',
				"  field!: Locator;",
				"}",
			].join("\n"),
		});
		expect(codes(warnings)).toContain("decorator-on-non-accessor");
	});

	it("flags a selector decorator on a getter", () => {
		const warnings = warningsFor({
			"src/a.ts": [
				PRELUDE,
				libImport("PageObject", "Selector"),
				"export class Host extends PageObject {",
				'  @Selector("x")',
				"  get field(): Locator { return undefined as unknown as Locator; }",
				"}",
			].join("\n"),
		});
		expect(codes(warnings)).toContain("decorator-on-non-accessor");
	});

	it("flags a root decorator on a PageObject subclass", () => {
		const warnings = warningsFor({
			"src/a.ts": [
				libImport("PageObject", "RootSelector"),
				'@RootSelector("Thing")',
				"export class Host extends PageObject {}",
			].join("\n"),
		});
		const found = warnings.find(
			(diagnostic) => diagnostic.code === "root-decorator-on-page-object",
		);
		expect(found).toBeDefined();
		expect(found?.severity).toBe("error");
		expect(found?.message).toContain("RootPageObject");
	});

	it("does not flag a root decorator on a RootPageObject subclass", () => {
		const warnings = warningsFor({
			"src/a.ts": [
				libImport("RootPageObject", "RootSelector"),
				'@RootSelector("Thing")',
				"export class Host extends RootPageObject {}",
			].join("\n"),
		});
		expect(codes(warnings)).not.toContain("root-decorator-on-page-object");
	});

	it("flags a PageObject subclass passed as a factory argument", () => {
		const warnings = warningsFor({
			"src/ctrl.ts": [
				libImport("PageObject"),
				"export class Ctrl extends PageObject {}",
			].join("\n"),
			"src/a.ts": [
				PRELUDE,
				libImport("PageObject", "Selector"),
				'import { Ctrl } from "./ctrl";',
				"export class Host extends PageObject {",
				'  @Selector("x", Ctrl)',
				"  accessor field!: Ctrl;",
				"}",
			].join("\n"),
		});
		expect(codes(warnings)).toContain("page-object-passed-as-factory");
	});

	it("flags a decorated class whose only `locator` is an accessor", () => {
		const warnings = warningsFor({
			"src/a.ts": [
				PRELUDE,
				libImport("Selector"),
				"export class Host {",
				"  constructor(private readonly _locator: Locator) {}",
				"  get locator(): Locator { return this._locator; }",
				'  @Selector("x")',
				"  accessor field!: Locator;",
				"}",
			].join("\n"),
		});
		const found = warnings.find(
			(diagnostic) => diagnostic.code === "missing-host-context",
		);
		expect(found).toBeDefined();
		expect(found?.message).toContain("data properties");
	});

	it("stays silent for a well-formed page object", () => {
		const warnings = warningsFor({
			"src/a.ts": [
				PRELUDE,
				libImport("RootPageObject", "RootSelector", "Selector"),
				'@RootSelector("Thing")',
				"export class Host extends RootPageObject {",
				'  @Selector("x")',
				"  accessor field!: Locator;",
				"}",
			].join("\n"),
		});
		expect(
			codes(warnings).filter((code) => !ENVIRONMENT_CODES.has(code)),
		).toEqual([]);
	});
});
