import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Project } from "ts-morph";
import { afterAll, describe, expect, it } from "vitest";
import { buildPageObjectTree } from "../../analysis/page-objects/tree";
import {
	packageSourceOutsideRoot,
	registerWorkspaceRoot,
} from "../../analysis/util/workspaceRoot";
import { Workspace } from "../../analysis/workspace";
import { libImport, makeWorkspace } from "./helpers/inMemory";

/**
 * Numbers a caller acts on, and the probe behind the one piece of advice this
 * server gives about its own scope.
 *
 * A count is not decoration. "3 more classes were left out" is what makes
 * someone widen a budget; "these packages are linked" is what makes them
 * re-root the server. Each of these was off in a way that pointed at the wrong
 * action.
 */

const roots: string[] = [];

function scratch(files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppo-probe-"));
	roots.push(root);
	for (const [relativePath, contents] of Object.entries(files)) {
		const absolute = path.join(root, relativePath);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, contents, "utf8");
	}
	return root;
}

afterAll(() => {
	for (const root of roots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
	Workspace.reset();
});

describe("the node-budget count", () => {
	it("counts classes, not the edges that reached them", () => {
		// Three members of the root all point at the same over-budget class. The
		// counter incremented per edge, so the warning said three classes were left
		// out when one was — and the number is the whole reason a reader would
		// raise the budget.
		const tree = buildPageObjectTree(
			makeWorkspace({
				"e2e/Shared.ts": [
					libImport("PageObject", "Selector"),
					"export class Shared extends PageObject {",
					'  @Selector("Inner")',
					"  accessor Inner!: never;",
					"}",
				].join("\n"),
				"e2e/HomePage.ts": [
					libImport("RootPageObject", "RootSelector", "Selector"),
					'import { Shared } from "./Shared";',
					"@RootSelector()",
					"export class HomePage extends RootPageObject {",
					'  @Selector("A")',
					"  accessor A: Shared = new Shared();",
					'  @Selector("B")',
					"  accessor B: Shared = new Shared();",
					'  @Selector("C")',
					"  accessor C: Shared = new Shared();",
					"}",
				].join("\n"),
			}),
			"HomePage",
			{ maxNodes: 1 },
		);
		const note = tree.warnings.find(
			(warning) => warning.code === "node-budget-reached",
		);
		expect(note).toBeDefined();
		expect(note?.message).toContain("1 more class was left out");
	});
});

describe("the linked-package probe", () => {
	/**
	 * Deeper than the old ten-hop cap. A monorepo importer this far below the
	 * `node_modules` holding the link read as an ordinary installed dependency,
	 * so `linkedCount` undercounted and `sourceRoot` — the one directory the
	 * remedy can name — lost it.
	 */
	it("finds a link more than ten directories above the importer", () => {
		const outer = scratch({
			"packages/ui/src/index.ts": "export const ui = 1;",
			"repo/package.json": "{}",
		});
		const deep = path.join(
			outer,
			"repo",
			"a/b/c/d/e/f/g/h/i/j/k/l/m/components",
		);
		fs.mkdirSync(deep, { recursive: true });
		fs.mkdirSync(path.join(outer, "repo", "node_modules"), { recursive: true });
		fs.symlinkSync(
			path.join(outer, "packages", "ui"),
			path.join(outer, "repo", "node_modules", "@acme-ui"),
			"junction",
		);

		const project = new Project({ useInMemoryFileSystem: false });
		registerWorkspaceRoot(project, path.join(outer, "repo"));
		const found = packageSourceOutsideRoot(project, deep, "@acme-ui");
		expect(found).not.toBeNull();
		expect(found).toContain("packages");
	});

	it("still answers null for a package with no link", () => {
		const root = scratch({ "src/a.ts": "export const a = 1;" });
		const project = new Project({ useInMemoryFileSystem: false });
		registerWorkspaceRoot(project, root);
		expect(
			packageSourceOutsideRoot(project, path.join(root, "src"), "@acme/nope"),
		).toBeNull();
	});
});

describe("the running file total", () => {
	it("counts the same set the cap counts", () => {
		// The total was the raw project length, which includes declaration files
		// and `node_modules`; the cap counts neither. Two effects, and the second
		// is why it matters: once enough `.d.ts` files push the raw number past the
		// limit, every on-demand admission falls into the full project walk the
		// total exists to avoid — permanently, on the largest repositories.
		//
		// This guards the invariant, not the fix: it passes either way, because
		// showing the divergence needs a repository large enough for the raw count
		// to cross the cap while the counted one does not. The two effects are a
		// wrong number in `large-scan` and a quadratic cost, neither of which a
		// fixture this size can show.
		const root = scratch({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { target: "ES2022", noEmit: true },
				include: ["src/**/*.ts", "types/**/*.d.ts"],
			}),
			"types/big.d.ts": "declare const big: number;",
			"types/other.d.ts": "declare const other: number;",
			"src/a.ts": 'import "./b";\nexport const a = 1;',
			"src/b.ts": "export const b = 1;",
		});
		Workspace.reset();
		// Two analysable files, two declaration files. A cap of 3 counts only the
		// former, so this must not refuse.
		const ws = Workspace.acquire({ projectRoot: root, maxFiles: 3 });
		expect(() => ws.sourceFiles()).not.toThrow();
	});
});
