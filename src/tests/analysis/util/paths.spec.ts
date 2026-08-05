import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	defKey,
	escapeRegExp,
	globToRegExp,
	isDeclarationFile,
	isIgnoredPath,
	keyFold,
	matchesAnyGlob,
	splitDefKey,
	toPosix,
	toPosixRelative,
} from "../../../analysis/util/paths";

describe("toPosixRelative", () => {
	it("normalises separators against the host platform's root", () => {
		const root = path.resolve("/repo");
		expect(toPosixRelative(root, path.join(root, "e2e", "a.ts"))).toBe(
			"e2e/a.ts",
		);
	});

	it("falls back to the absolute posix path when outside the root", () => {
		const root = path.resolve("/repo");
		const outside = path.resolve("/elsewhere/a.ts");
		expect(toPosixRelative(root, outside)).toBe(toPosix(outside));
	});

	it("returns `.` for the root itself", () => {
		const root = path.resolve("/repo");
		expect(toPosixRelative(root, root)).toBe(".");
	});
});

describe("defKey / keyFold", () => {
	it("builds a stable display key", () => {
		expect(defKey("e2e\\page-objects\\A.ts", "A")).toBe(
			"e2e/page-objects/A.ts#A",
		);
	});

	it("folds case for lookups without mangling the display key", () => {
		const key = defKey("E2E/CheckoutPage.ts", "CheckoutPage");
		expect(keyFold(key)).toBe("e2e/checkoutpage.ts#checkoutpage");
		expect(key).toBe("E2E/CheckoutPage.ts#CheckoutPage");
	});

	it("splits on the last hash so paths containing one still work", () => {
		expect(splitDefKey("a/b#c.ts#C")).toEqual({ file: "a/b#c.ts", name: "C" });
	});
});

describe("isIgnoredPath / isDeclarationFile", () => {
	it("skips build and dependency directories", () => {
		expect(isIgnoredPath("node_modules/x/index.ts")).toBe(true);
		expect(isIgnoredPath("example/dist/a.js")).toBe(true);
		expect(isIgnoredPath("src/analysis/index.ts")).toBe(false);
	});

	it("recognises every declaration-file extension", () => {
		expect(isDeclarationFile("/a/b.d.ts")).toBe(true);
		expect(isDeclarationFile("/a/b.d.mts")).toBe(true);
		expect(isDeclarationFile("/a/b.ts")).toBe(false);
	});
});

describe("globToRegExp", () => {
	it("matches `**/` across zero or more directories", () => {
		const regex = globToRegExp("**/*.tsx");
		expect(regex.test("App.tsx")).toBe(true);
		expect(regex.test("src/components/App.tsx")).toBe(true);
		expect(regex.test("src/App.ts")).toBe(false);
	});

	it("keeps `*` inside one segment", () => {
		expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
		expect(globToRegExp("src/*.ts").test("src/nested/a.ts")).toBe(false);
	});

	it("expands brace alternatives", () => {
		expect(matchesAnyGlob("e2e/a.spec.ts", ["**/*.{spec,test}.ts"])).toBe(true);
		expect(matchesAnyGlob("e2e/a.other.ts", ["**/*.{spec,test}.ts"])).toBe(
			false,
		);
	});
});

describe("escapeRegExp", () => {
	it("escapes regex metacharacters", () => {
		expect(escapeRegExp("CartItem_(1)")).toBe("CartItem_\\(1\\)");
	});
});
