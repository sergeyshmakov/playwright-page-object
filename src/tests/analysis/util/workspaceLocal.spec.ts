import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import { foldPath, toPosix } from "../../../analysis/util/paths";
import { resolveIdentifier } from "../../../analysis/util/resolve";
import { isWorkspaceLocal } from "../../../analysis/util/workspaceRoot";
import { Workspace } from "../../../analysis/workspace";

/**
 * Telling a linked workspace package apart from an installed dependency.
 *
 * npm, yarn and pnpm all publish a monorepo's own packages into `node_modules`
 * as symlinks (POSIX) or directory junctions (Windows). Classifying by the path
 * we walked to reach a file makes every one of those an external boundary, so a
 * repository whose components all come from `@company/ui` gets an empty tree
 * and is told its own source is a third-party dependency.
 *
 * These have to run against a real filesystem: ts-morph's in-memory host models
 * no links at all.
 */

const roots: string[] = [];

function scratch(files: Record<string, string>): string {
	const root = fs.realpathSync.native(
		fs.mkdtempSync(path.join(os.tmpdir(), "ppo-link-")),
	);
	roots.push(root);
	for (const [relativePath, contents] of Object.entries(files)) {
		const absolute = path.join(root, relativePath);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, contents, "utf8");
	}
	return root;
}

/**
 * `fs.symlinkSync(target, link, "junction")` makes a directory junction on
 * Windows — which needs no elevation, unlike a *file* symlink — and an ordinary
 * directory symlink everywhere else, because POSIX ignores the type argument.
 * Restricted containers and some overlay mounts still refuse; those skip.
 */
function canLink(): boolean {
	const probe = fs.mkdtempSync(path.join(os.tmpdir(), "ppo-linkprobe-"));
	try {
		fs.mkdirSync(path.join(probe, "target"));
		fs.symlinkSync(
			path.join(probe, "target"),
			path.join(probe, "link"),
			"junction",
		);
		return fs.existsSync(path.join(probe, "link"));
	} catch {
		return false;
	} finally {
		fs.rmSync(probe, { recursive: true, force: true });
	}
}

const LINKS_WORK = canLink();

function link(root: string, from: string, to: string): void {
	const linkPath = path.join(root, from);
	fs.mkdirSync(path.dirname(linkPath), { recursive: true });
	fs.symlinkSync(path.join(root, to), linkPath, "junction");
}

/** A monorepo whose `@acme/ui` package is linked into `node_modules`. */
const MONOREPO = {
	"tsconfig.json": JSON.stringify({
		compilerOptions: { jsx: "react-jsx", target: "ES2022" },
		include: ["apps"],
	}),
	"packages/ui/package.json": JSON.stringify({
		name: "@acme/ui",
		source: "src/index.tsx",
	}),
	"packages/ui/src/index.tsx": [
		"export function Gapped({ children }: { children?: unknown }) {",
		'\treturn <div data-testid="GappedRoot">{children as never}</div>;',
		"}",
		"",
	].join("\n"),
	"apps/web/src/App.tsx": [
		'import { Gapped } from "@acme/ui";',
		"export default function App() {",
		'\treturn <Gapped><span data-testid="Inner" /></Gapped>;',
		"}",
		"",
	].join("\n"),
};

beforeEach(() => {
	Workspace.reset();
	vi.restoreAllMocks();
});

afterAll(() => {
	for (const root of roots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe.skipIf(!LINKS_WORK)("isWorkspaceLocal", () => {
	it("follows a junction back into the workspace and rejects a real dependency", () => {
		const root = scratch({
			...MONOREPO,
			"node_modules/react/index.js": "module.exports = {};",
		});
		link(root, "node_modules/@acme/ui", "packages/ui");
		const ws = Workspace.acquire({ projectRoot: root });

		expect(
			isWorkspaceLocal(
				ws.project,
				`${toPosix(root)}/node_modules/@acme/ui/src/index.tsx`,
			),
		).toBe(true);
		expect(
			isWorkspaceLocal(
				ws.project,
				`${toPosix(root)}/node_modules/react/index.js`,
			),
		).toBe(false);
	});

	it("compares against the real workspace root", () => {
		// `os.tmpdir()` is `/var/…` on macOS and `/private/var/…` after realpath.
		// Comparing an un-resolved root against a resolved file classifies every
		// temp-dir fixture as outside the root.
		const root = scratch(MONOREPO);
		link(root, "node_modules/@acme/ui", "packages/ui");
		const linked = path.join(root, "node_modules", "@acme", "ui", "src");
		const ws = Workspace.acquire({
			projectRoot: path.join(root, "..", path.basename(root)),
		});

		expect(isWorkspaceLocal(ws.project, `${toPosix(linked)}/index.tsx`)).toBe(
			true,
		);
	});

	it("folds case exactly where the filesystem folds it", () => {
		const root = scratch(MONOREPO);
		link(root, "node_modules/@acme/ui", "packages/ui");
		const ws = Workspace.acquire({ projectRoot: root });
		const inside = `${toPosix(root)}/packages/ui/src/index.tsx`;

		expect(isWorkspaceLocal(ws.project, inside)).toBe(true);
		if (foldPath("A") === foldPath("a")) {
			expect(isWorkspaceLocal(ws.project, inside.toUpperCase())).toBe(true);
		}
	});
});

describe.skipIf(!LINKS_WORK)(
	"workspace package behind a node_modules link",
	() => {
		it("expands the linked component and reports its real path", () => {
			const root = scratch(MONOREPO);
			link(root, "node_modules/@acme/ui", "packages/ui");
			const ws = Workspace.acquire({ projectRoot: root });

			const tree = buildTestIdTree(ws, { entry: "apps/web/src/App.tsx" });
			const gapped = tree.roots[0];
			expect(gapped.tag).toBe("Gapped");
			expect(gapped.unresolved).toBeUndefined();
			// Loading it under the link path would put it in the project as
			// `node_modules/…`, which `isAnalysable` drops from `sourceFiles()` — the
			// ids would reach the tree and never reach the inventory.
			expect(gapped.children[0]?.file).toBe("packages/ui/src/index.tsx");
			expect(gapped.children[0]?.testId).toMatchObject({ value: "GappedRoot" });
			expect(
				ws.project
					.getSourceFiles()
					.map((file) => toPosix(file.getFilePath()))
					.filter((file) => file.includes("/node_modules/")),
			).toEqual([]);
		});

		it("back-fills the linked package's ids into the inventory", () => {
			const root = scratch(MONOREPO);
			link(root, "node_modules/@acme/ui", "packages/ui");
			const ws = Workspace.acquire({ projectRoot: root });

			// The tsconfig scopes the scan to `apps`, so `packages/ui` only joins the
			// project when the walk resolves the import — after the memoized file list
			// was built. Its ids would otherwise be in `roots` and not in `inventory`,
			// and `map_coverage` would call every selector for them dead.
			const tree = buildTestIdTree(ws, { entry: "apps/web/src/App.tsx" });
			expect(tree.inventory.map((entry) => entry.value.value).sort()).toEqual([
				"GappedRoot",
				"Inner",
			]);
			expect(tree.stats.files).toBe(2);
		});

		it("reads the package realpath once however many files it holds", () => {
			const files: Record<string, string> = { ...MONOREPO };
			for (let index = 0; index < 8; index += 1) {
				files[`packages/ui/src/W${index}.tsx`] =
					`export function W${index}() { return <b data-testid="W${index}" />; }\n`;
			}
			files["packages/ui/src/index.tsx"] = [
				...Array.from(
					{ length: 8 },
					(_, index) => `export { W${index} } from "./W${index}";`,
				),
				"export function Gapped({ children }: { children?: unknown }) {",
				'\treturn <div data-testid="GappedRoot">{children as never}</div>;',
				"}",
				"",
			].join("\n");
			files["apps/web/src/App.tsx"] = [
				'import { Gapped, W0, W1, W2, W3 } from "@acme/ui";',
				"export default function App() {",
				"\treturn <Gapped><W0 /><W1 /><W2 /><W3 /></Gapped>;",
				"}",
				"",
			].join("\n");

			const root = scratch(files);
			link(root, "node_modules/@acme/ui", "packages/ui");
			const spy = vi.spyOn(fs.realpathSync, "native");
			const ws = Workspace.acquire({ projectRoot: root });
			const tree = buildTestIdTree(ws, { entry: "apps/web/src/App.tsx" });

			// Only this engine ever resolves a `node_modules` path — TypeScript's own
			// host realpaths ordinary directories, and never descends there — so these
			// calls are exactly the link classifications. One package, one syscall,
			// however many of its files the walk pulls in.
			const linkCalls = spy.mock.calls.filter((call) =>
				toPosix(String(call[0])).includes("/node_modules/"),
			);
			expect(tree.stats.files).toBeGreaterThan(4);
			expect(linkCalls).toHaveLength(1);
		});
	},
);

describe("installed dependencies stay unread", () => {
	it("never parses a real node_modules package", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { jsx: "react-jsx", target: "ES2022" },
			}),
			"node_modules/react/package.json": JSON.stringify({
				name: "react",
				main: "index.js",
			}),
			"node_modules/react/index.js": "module.exports = {};",
			"src/App.tsx": [
				'import React from "react";',
				"export default function App() { return <div />; }",
				"",
			].join("\n"),
		});
		const ws = Workspace.acquire({ projectRoot: root });
		const app = ws.project.getSourceFileOrThrow(
			path.join(root, "src", "App.tsx"),
		);

		const resolution = resolveIdentifier(ws.project, app, "React");
		expect(resolution.resolved).toBe(false);
		if (!resolution.resolved) {
			expect(resolution.external).toBe(true);
		}
		expect(
			ws.project
				.getSourceFiles()
				.map((file) => toPosix(file.getFilePath()))
				.filter((file) => file.includes("/node_modules/")),
		).toEqual([]);
	});

	it.skipIf(!LINKS_WORK)(
		"names a workspace package that only ships built output",
		() => {
			const root = scratch({
				"tsconfig.json": JSON.stringify({
					compilerOptions: { jsx: "react-jsx", target: "ES2022" },
					include: ["apps"],
				}),
				"packages/built/package.json": JSON.stringify({
					name: "@acme/built",
					main: "dist/index.js",
				}),
				"packages/built/dist/index.js": "exports.Gapped = function () {};",
				"apps/web/src/App.tsx": [
					'import { Gapped } from "@acme/built";',
					"export default function App() { return <Gapped />; }",
					"",
				].join("\n"),
			});
			link(root, "node_modules/@acme/built", "packages/built");
			const ws = Workspace.acquire({ projectRoot: root });
			const app = ws.project.getSourceFileOrThrow(
				path.join(root, "apps", "web", "src", "App.tsx"),
			);

			const resolution = resolveIdentifier(ws.project, app, "Gapped");
			expect(resolution.resolved).toBe(false);
			if (!resolution.resolved && resolution.external) {
				// "External dependency" is the wrong thing to say about code in the
				// caller's own repository; "we only found compiled output" is not.
				expect(resolution.module).toBe("@acme/built (built output)");
			}
			expect(
				ws.project
					.getSourceFiles()
					.map((file) => toPosix(file.getFilePath()))
					.filter((file) => file.includes("/dist/")),
			).toEqual([]);
		},
	);
});
