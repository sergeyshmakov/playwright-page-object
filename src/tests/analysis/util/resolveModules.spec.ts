import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toPosix } from "../../../analysis/util/paths";
import {
	isInNodeModules,
	resolveIdentifier,
	resolveRelativeModule,
} from "../../../analysis/util/resolve";
import { WorkspacePool } from "../../../analysis/workspace";
import {
	MEMORY_ROOT_POSIX,
	makeWorkspace,
	memoryPath,
} from "../helpers/inMemory";
import { cleanupScratchRoots, scratchRepo } from "../helpers/onDisk";

/**
 * Finding the *module* a name comes from: tsconfig `paths`, `baseUrl`, the
 * `node_modules` walk, and how far a re-export chain may be followed.
 *
 * Split from `resolve.spec.ts`, which keeps the question of what a name
 * resolves to once the module is known.
 */

/** One per spec file, so nothing leaks between them. */
const pool = new WorkspacePool();

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

describe("relative module resolution freshness", () => {
	afterEach(() => {
		pool.clear();
		cleanupScratchRoots();
	});

	function scratch(files: Record<string, string>): string {
		return scratchRepo(files, { prefix: "ppo-resolve-" });
	}

	/**
	 * A module base that resolved to nothing must be re-probed, not remembered.
	 *
	 * This is why {@link loadFromBase} carries no cache. Nothing bumps the epoch
	 * when a file appears *outside* the scan globs — the re-glob does not see it
	 * and the mtime sweep only walks files already in the project — so a
	 * remembered "no such module" would outlive its evidence for the whole
	 * session, and the import would stay unresolved until a restart.
	 */
	it("picks up a module created outside the scan globs, with no epoch bump", () => {
		const root = scratch({
			"src/a.ts": [
				'import { Widget } from "../lib/widget";',
				"const x = Widget;",
			].join("\n"),
			"lib/.keep": "",
		});
		const ws = pool.acquire({ projectRoot: root, include: ["src"] });
		const sourceFile = ws.project.getSourceFileOrThrow(
			toPosix(path.join(root, "src/a.ts")),
		);
		expect(
			resolveRelativeModule(ws.project, sourceFile, "../lib/widget"),
		).toBeUndefined();

		fs.writeFileSync(
			path.join(root, "lib/widget.ts"),
			"export class Widget {}",
			"utf8",
		);

		const resolved = resolveRelativeModule(
			ws.project,
			sourceFile,
			"../lib/widget",
		);
		expect(resolved?.getBaseName()).toBe("widget.ts");
	});

	it("hands back the same file object for a repeated hit", () => {
		const root = scratch({
			"src/a.ts": [
				'import { Widget } from "./widget";',
				"const x = Widget;",
			].join("\n"),
			"src/widget.ts": "export class Widget {}",
		});
		const ws = pool.acquire({ projectRoot: root });
		const sourceFile = ws.project.getSourceFileOrThrow(
			toPosix(path.join(root, "src/a.ts")),
		);
		const first = resolveRelativeModule(ws.project, sourceFile, "./widget");
		const second = resolveRelativeModule(ws.project, sourceFile, "./widget");
		expect(first).toBeDefined();
		expect(second).toBe(first);
	});
});

describe("isInNodeModules", () => {
	it("detects dependency paths on both separators", () => {
		expect(isInNodeModules("/repo/node_modules/x/index.d.ts")).toBe(true);
		expect(isInNodeModules("C:\\repo\\node_modules\\x\\index.d.ts")).toBe(true);
		expect(isInNodeModules("/repo/src/index.ts")).toBe(false);
	});
});

describe("how far a re-export chain may go", () => {
	/**
	 * The hop count used to be doing two jobs: bounding cost, and stopping a
	 * cyclic re-export from recursing forever. That is why it sat at 4 - low
	 * enough that a design system whose public name reaches its declaration
	 * through six index files never resolved.
	 *
	 * And exhaustion does not say "too deep". It returns `identifier-unresolved`,
	 * whose hint tells the caller to root a tree at the component - which runs
	 * the same lookup with the same budget and fails the same way.
	 */
	it("resolves a name through eight nested index files", () => {
		const files: Record<string, string> = {
			"src/deep/Button.tsx": "export class Button {}\n",
		};
		let previous = "deep/Button";
		for (let level = 7; level >= 0; level -= 1) {
			const here = `src/i${level}.ts`;
			files[here] = `export * from "./${previous}";\n`;
			previous = `i${level}`;
		}
		files["src/App.tsx"] = [
			'import { Button } from "./i0";',
			"export const used = Button;",
			"",
		].join("\n");

		const ws = makeWorkspace(files);
		const entry = ws.project.getSourceFileOrThrow(memoryPath("src/App.tsx"));
		const resolution = resolveIdentifier(ws.project, entry, "Button");
		expect(resolution.resolved).toBe(true);
	});

	it("terminates on two modules re-exporting each other", () => {
		// `visited` is the termination argument now, so this must not depend on
		// the budget running out - and must not hang if the budget is raised.
		const ws = makeWorkspace({
			"src/a.ts": 'export * from "./b";\n',
			"src/b.ts": 'export * from "./a";\n',
			"src/App.tsx": [
				'import { Missing } from "./a";',
				"export const used = Missing;",
				"",
			].join("\n"),
		});
		const entry = ws.project.getSourceFileOrThrow(memoryPath("src/App.tsx"));
		const resolution = resolveIdentifier(ws.project, entry, "Missing");
		expect(resolution.resolved).toBe(false);
	});
});
