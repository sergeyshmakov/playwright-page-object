import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	defKey,
	escapeRegExp,
	isCaseInsensitiveFileSystem,
	isDeclarationFile,
	isGlobPattern,
	isIgnoredPath,
	isOutsideRoot,
	keyFold,
	matchesAnyGlob,
	splitDefKey,
	toPosix,
	toPosixRelative,
} from "../../../analysis/util/paths";

/** Runs `body` as if the host were `platform`, then restores the real one. */
function withPlatform(platform: NodeJS.Platform, body: () => void): void {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
	});
	try {
		body();
	} finally {
		if (original) {
			Object.defineProperty(process, "platform", original);
		}
	}
}

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

	it("keeps a directory whose name merely starts with dots", () => {
		const root = path.resolve("/repo");
		const inside = path.join(root, "..config", "a.ts");
		expect(toPosixRelative(root, inside)).toBe("..config/a.ts");
		expect(isOutsideRoot(toPosixRelative(root, inside))).toBe(false);
	});
});

describe("isOutsideRoot", () => {
	it("treats `..` as a whole segment", () => {
		expect(isOutsideRoot("..")).toBe(true);
		expect(isOutsideRoot("../sibling/a.ts")).toBe(true);
		expect(isOutsideRoot("..config/a.ts")).toBe(false);
	});

	it("recognises absolute paths in both posix and Windows form", () => {
		expect(isOutsideRoot("/elsewhere/a.ts")).toBe(true);
		expect(isOutsideRoot("C:/elsewhere/a.ts")).toBe(true);
		expect(isOutsideRoot("src/a.ts")).toBe(false);
	});
});

describe("defKey / keyFold", () => {
	it("builds a stable display key", () => {
		expect(defKey("e2e\\page-objects\\A.ts", "A")).toBe(
			"e2e/page-objects/A.ts#A",
		);
	});

	it("folds the file half for lookups without mangling the display key", () => {
		const key = defKey("E2E/CheckoutPage.ts", "CheckoutPage");
		withPlatform("win32", () => {
			expect(keyFold(key)).toBe("e2e/checkoutpage.ts#CheckoutPage");
		});
		expect(key).toBe("E2E/CheckoutPage.ts#CheckoutPage");
	});

	it("folds on a case-insensitive filesystem", () => {
		for (const platform of ["win32", "darwin"] as const) {
			withPlatform(platform, () => {
				expect(isCaseInsensitiveFileSystem()).toBe(true);
				expect(keyFold(defKey("pages/Foo.ts", "Checkout"))).toBe(
					keyFold(defKey("pages/foo.ts", "Checkout")),
				);
			});
		}
	});

	it("keeps paths that differ only by case apart on a case-sensitive one", () => {
		withPlatform("linux", () => {
			expect(isCaseInsensitiveFileSystem()).toBe(false);
			expect(keyFold(defKey("pages/Foo.ts", "Checkout"))).toBe(
				"pages/Foo.ts#Checkout",
			);
			expect(keyFold(defKey("pages/Foo.ts", "Checkout"))).not.toBe(
				keyFold(defKey("pages/foo.ts", "Checkout")),
			);
		});
	});

	it("keeps classes that differ only by case apart", () => {
		expect(keyFold(defKey("src/a.ts", "Panel"))).not.toBe(
			keyFold(defKey("src/a.ts", "panel")),
		);
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

/**
 * Characterization of the glob engine.
 *
 * Every row is a *measured* answer, not an intended one: the same pattern a
 * caller writes for `--src-dir` is handed to ts-morph's `addSourceFilesAtPaths`
 * as well, which globs with picomatch. Whenever the two engines disagree the
 * analysed scope comes out silently empty, so the table exists to make any
 * change of answer a visible diff rather than a silent one.
 */
describe("matchesAnyGlob", () => {
	/** `[pattern, workspace-relative posix path, matches]`. */
	const CASES: ReadonlyArray<readonly [string, string, boolean]> = [
		// Segment and globstar matching.
		["**/*.tsx", "App.tsx", true],
		["**/*.tsx", "src/components/App.tsx", true],
		["**/*.tsx", "src/App.ts", false],
		["src/*.ts", "src/a.ts", true],
		["src/*.ts", "src/nested/a.ts", false],
		["src/**/*.ts", "src/a.ts", true],
		["src/**", "src/a/b.ts", true],
		// A trailing `**` covers the directory itself, which is how every other
		// glob engine reads it.
		["src/**", "src", true],

		// Brace alternatives, including stars inside a brace and nested braces.
		["**/*.{spec,test}.ts", "e2e/a.spec.ts", true],
		["**/*.{spec,test}.ts", "e2e/a.other.ts", false],
		["**/{*.ts,*.tsx}", "src/a/b.tsx", true],
		["**/{*.ts,*.tsx}", "src/a/b.ts", true],
		["src/{a,{b,c}}/x.ts", "src/b/x.ts", true],
		["src/{a,{b,c}}/x.ts", "src/d/x.ts", false],

		// Character classes.
		["src/[ab]/x.ts", "src/a/x.ts", true],
		["src/[ab]/x.ts", "src/c/x.ts", false],

		// Extglobs.
		["src/?(a|b).ts", "src/a.ts", true],
		["+(a|b).ts", "a.ts", true],
		["src/@(foo|bar)/x.ts", "src/foo/x.ts", true],

		// Dot directories and dotfiles are ordinary source here: a `.storybook`
		// tree holds components the engine has to read.
		["src/**/*.ts", "src/.storybook/a.ts", true],
		["src/**/*.ts", "src/.hidden.ts", true],
		["**/*.{ts,tsx,mts,cts,jsx}", ".storybook/main.ts", true],

		// A leading `!` is a literal character: negation is resolved one layer up,
		// in `withNormalizedScope`, which rewrites it into an `exclude` entry.
		["!src/a.ts", "!src/a.ts", true],
		["!src/a.ts", "src/a.ts", false],
		["!src/a.ts", "other.ts", false],

		// Characters that are regex magic but not glob magic stay literal.
		["a+b/x.ts", "a+b/x.ts", true],
		["src/a.ts", "src/a.ts", true],
		["src/a.ts", "srcXa.ts", false],

		// Paths are posix on every platform; a backslash is not a separator.
		["src/*.ts", "src\\a.ts", false],
	];

	it.each(CASES)("%j matches %j -> %s", (glob, relPath, expected) => {
		expect(matchesAnyGlob(relPath, [glob])).toBe(expected);
	});

	it("matches against every pattern in the list", () => {
		const globs = ["src/**/*.ts", "e2e/**/*.ts"];
		expect(matchesAnyGlob("e2e/b.ts", globs)).toBe(true);
		expect(matchesAnyGlob("src/a.ts", globs)).toBe(true);
		expect(matchesAnyGlob("lib/c.ts", globs)).toBe(false);
	});

	it("matches nothing against an empty pattern list", () => {
		expect(matchesAnyGlob("src/a.ts", [])).toBe(false);
	});

	// A caller-supplied pattern may arrive spelled the way Windows spells paths.
	it("reads a pattern written with backslashes as posix", () => {
		expect(matchesAnyGlob("src/a.ts", ["src\\a.ts"])).toBe(true);
		expect(matchesAnyGlob("src/nested/a.ts", ["src\\**\\*.ts"])).toBe(true);
	});
});

describe("isGlobPattern", () => {
	it("reads a plain path as a plain path", () => {
		for (const literal of [
			"src",
			"e2e/tests",
			"a.config.ts",
			".storybook",
			"packages/ui-2.0/src",
		]) {
			expect(isGlobPattern(literal)).toBe(false);
			// The verdict has to agree with the matcher: a pattern called literal
			// here is expanded into a directory glob, and one called a glob is
			// passed through untouched. Either way the matcher reads it next.
			expect(matchesAnyGlob(literal, [literal])).toBe(true);
		}
	});

	it("recognises every shape picomatch treats as magic", () => {
		for (const glob of [
			"src/**/*.ts",
			"src/*",
			"{a,b}",
			"src/[ab]",
			"src/?(a).ts",
			// Extglobs: the hand-rolled `[*?[\]{}]` set called these plain paths,
			// so the scope normalizer expanded them as directory names.
			"+(a|b).ts",
			"src/@(a|b)",
			"src/!(generated)",
		]) {
			expect(isGlobPattern(glob)).toBe(true);
		}
	});
});

describe("escapeRegExp", () => {
	it("escapes regex metacharacters", () => {
		expect(escapeRegExp("CartItem_(1)")).toBe("CartItem_\\(1\\)");
	});
});
