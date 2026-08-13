import * as fs from "node:fs";
import * as path from "node:path";
import { Project } from "ts-morph";
import { describe, expect, it, vi } from "vitest";
import { staticId } from "../../../analysis";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import { foldPath, toPosix } from "../../../analysis/util/paths";
import { resolveIdentifier } from "../../../analysis/util/resolve";
import {
	isWorkspaceLocal,
	linkedWorkspaceDirectory,
	realDirectory,
	registerWorkspaceRoot,
} from "../../../analysis/util/workspaceRoot";
import {
	aliasOf,
	LINKS_WORK,
	link,
	MONOREPO,
	pool,
	scratch,
} from "../helpers/linkedWorkspace";

describe.skipIf(!LINKS_WORK)("isWorkspaceLocal", () => {
	it("follows a junction back into the workspace and rejects a real dependency", () => {
		const root = scratch({
			...MONOREPO,
			"node_modules/react/index.js": "module.exports = {};",
		});
		link(root, "node_modules/@acme/ui", "packages/ui");
		const ws = pool.acquire({ projectRoot: root });

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
		//
		// The root the workspace is given here is a *link* to the fixture, so the
		// two spellings really do differ — `path.join(root, "..", basename(root))`
		// normalises straight back to `root` and exercises nothing.
		const root = scratch(MONOREPO);
		link(root, "node_modules/@acme/ui", "packages/ui");
		const alias = aliasOf(root);
		const ws = pool.acquire({ projectRoot: alias });

		// Spelled with the resolved root: what `realpath` answers with, and
		// therefore what the classifier compares against the configured root.
		expect(
			isWorkspaceLocal(
				ws.project,
				`${toPosix(root)}/node_modules/@acme/ui/src/index.tsx`,
			),
		).toBe(true);
		// And spelled with the un-resolved one, which is how the project's own
		// files are named.
		expect(
			isWorkspaceLocal(
				ws.project,
				`${toPosix(alias)}/node_modules/@acme/ui/src/index.tsx`,
			),
		).toBe(true);
	});

	// npm writes `node_modules`, but nothing stops a path from reaching the
	// engine spelled otherwise, and on NTFS or APFS that is the same directory.
	it("reads a differently cased node_modules the way the filesystem does", () => {
		const root = scratch({
			...MONOREPO,
			"node_modules/react/index.js": "module.exports = {};",
		});
		link(root, "node_modules/@acme/ui", "packages/ui");
		const ws = pool.acquire({ projectRoot: root });
		const spelled = `${toPosix(root)}/Node_Modules/react/index.js`;

		// Case-folding filesystem: the installed dependency it really is. Case
		// sensitive: a different path entirely, which never went through
		// `node_modules` and is ordinary (missing) source.
		expect(isWorkspaceLocal(ws.project, spelled)).toBe(
			foldPath("A") !== foldPath("a"),
		);
	});

	it("folds case exactly where the filesystem folds it", () => {
		const root = scratch(MONOREPO);
		link(root, "node_modules/@acme/ui", "packages/ui");
		const ws = pool.acquire({ projectRoot: root });
		const inside = `${toPosix(root)}/packages/ui/src/index.tsx`;

		expect(isWorkspaceLocal(ws.project, inside)).toBe(true);
		if (foldPath("A") === foldPath("a")) {
			expect(isWorkspaceLocal(ws.project, inside.toUpperCase())).toBe(true);
		}
	});
});

/**
 * A UNC root needs no share to test: what matters is the spelling
 * `realpathSync.native` answers with, and mocking that is the only way to get
 * `\\?\UNC\…` in front of the normalizer on a machine with no network volume.
 */
describe("extended-length Windows paths", () => {
	const UNC_ROOT = "//server/share/repo";

	/** What the native realpath hands back on a UNC volume. */
	function extended(posixPath: string): string {
		return posixPath.replace(/^\/\//, "\\\\?\\UNC\\").replace(/\//g, "\\");
	}

	it("normalizes a `\\\\?\\UNC\\` real path to its ordinary spelling", () => {
		const project = new Project({ useInMemoryFileSystem: true });
		vi.spyOn(fs.realpathSync, "native").mockImplementation(((
			target: string,
		) => {
			const posix = toPosix(String(target));
			return extended(
				posix === `${UNC_ROOT}/node_modules/@acme/ui`
					? `${UNC_ROOT}/packages/ui`
					: posix,
			);
		}) as typeof fs.realpathSync.native);
		registerWorkspaceRoot(project, UNC_ROOT);

		// Stripping `\\?\` outright leaves `UNC/server/share/…`: a path under no
		// root and no drive, so the linked package is loaded from nowhere and the
		// whole workspace package is reported external.
		expect(realDirectory(project, `${UNC_ROOT}/node_modules/@acme/ui`)).toBe(
			`${UNC_ROOT}/packages/ui`,
		);
		expect(
			linkedWorkspaceDirectory(project, `${UNC_ROOT}/node_modules/@acme/ui`),
		).toBe(`${UNC_ROOT}/packages/ui`);
	});
});

describe.skipIf(!LINKS_WORK)(
	"workspace package behind a node_modules link",
	() => {
		it("expands the linked component and reports its real path", () => {
			const root = scratch(MONOREPO);
			link(root, "node_modules/@acme/ui", "packages/ui");
			const ws = pool.acquire({ projectRoot: root });

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
			const ws = pool.acquire({ projectRoot: root });

			// The tsconfig scopes the scan to `apps`, so `packages/ui` only joins the
			// project when the walk resolves the import — after the memoized file list
			// was built. Its ids would otherwise be in `roots` and not in `inventory`,
			// and `map_coverage` would call every selector for them dead.
			const tree = buildTestIdTree(ws, { entry: "apps/web/src/App.tsx" });
			expect(
				tree.inventory.map((entry) => staticId(entry.value)).sort(),
			).toEqual(["GappedRoot", "Inner"]);
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
			const ws = pool.acquire({ projectRoot: root });
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
		const ws = pool.acquire({ projectRoot: root });
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
			const ws = pool.acquire({ projectRoot: root });
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

/**
 * Where to root an analysis whose components come from outside it.
 *
 * A repository rooted at one app of a monorepo reaches its sibling packages
 * through `node_modules` links, and every one of those is an external boundary:
 * their test ids are invisible and every selector for them reads as dead. The
 * remedy the report used to offer — add their directories to the scanned
 * sources — cannot work, because anything outside the root is dropped before it
 * is counted. What *does* work is re-rooting, and when the link lands on source
 * the directory can be named exactly instead of described.
 */
describe.skipIf(!LINKS_WORK)("externalModuleRoot", () => {
	const APP_ONLY = {
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
		"apps/web/tsconfig.json": JSON.stringify({
			compilerOptions: { jsx: "react-jsx", target: "ES2022" },
			include: ["src"],
		}),
		"apps/web/src/App.tsx": [
			'import { Gapped } from "@acme/ui";',
			"export default function App() {",
			'\treturn <Gapped><span data-testid="Inner" /></Gapped>;',
			"}",
			"",
		].join("\n"),
	};

	it("names the directory that would bring a linked sibling into scope", () => {
		const root = scratch(APP_ONLY);
		link(root, "node_modules/@acme/ui", "packages/ui");
		const ws = pool.acquire({
			projectRoot: path.join(root, "apps", "web"),
		});

		const tree = buildTestIdTree(ws);
		expect(tree.externalModules).toEqual(["@acme/ui"]);
		// The deepest directory holding both the current root and the sources: the
		// value to pass as the new project root, not a description of one.
		expect(tree.externalModuleRoot).toBe(toPosix(root));
	});

	it("says nothing when the package really is installed", () => {
		const root = scratch({
			...APP_ONLY,
			"node_modules/@acme/ui/package.json": JSON.stringify({
				name: "@acme/ui",
				source: "src/index.tsx",
			}),
			"node_modules/@acme/ui/src/index.tsx":
				'export function Gapped() { return <div data-testid="GappedRoot" />; }\n',
		});
		const ws = pool.acquire({
			projectRoot: path.join(root, "apps", "web"),
		});

		const tree = buildTestIdTree(ws);
		expect(tree.externalModules).toEqual(["@acme/ui"]);
		// No scope change reaches a published package, so promising one would be
		// advice that cannot be followed.
		expect(tree.externalModuleRoot).toBeUndefined();
	});
});

describe.skipIf(!LINKS_WORK)("a source far below the analysed root", () => {
	/**
	 * The walk up to `node_modules` stops at the filesystem root and at the
	 * analysed root, and the second is what makes it correct - a `node_modules`
	 * above the project belongs to somebody else. A ten-hop cap cut in before
	 * either, so a source ten or more levels down never reached the root's own
	 * `node_modules` and its linked workspace packages were classified external:
	 * first-party code reported as a third-party boundary, in a repository deep
	 * enough that nobody would suspect the depth.
	 */
	it("resolves a linked package from twelve directories down", () => {
		const deep = "apps/web/src/a/b/c/d/e/f/g/h/i/App.tsx";
		const root = scratch({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { jsx: "react-jsx", target: "ES2022" },
				include: ["apps"],
			}),
			"packages/ui/package.json": JSON.stringify({
				name: "@acme/ui",
				main: "src/index.tsx",
			}),
			"packages/ui/src/index.tsx":
				'export function Gapped() { return <b data-testid="GappedRoot" />; }\n',
			[deep]: [
				'import { Gapped } from "@acme/ui";',
				"export default function App() { return <Gapped />; }",
				"",
			].join("\n"),
		});
		link(root, "node_modules/@acme/ui", "packages/ui");

		const ws = pool.acquire({ projectRoot: root });
		const entry = ws.project.getSourceFileOrThrow(path.join(root, deep));
		const resolution = resolveIdentifier(ws.project, entry, "Gapped");
		expect(resolution.resolved, "the link leads back into the workspace").toBe(
			true,
		);
		if (resolution.resolved) {
			expect(ws.rel(resolution.sourceFile.getFilePath())).toBe(
				"packages/ui/src/index.tsx",
			);
		}
	});
});
