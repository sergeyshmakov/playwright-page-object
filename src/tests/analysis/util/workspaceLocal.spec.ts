import * as fs from "node:fs";
import * as path from "node:path";
import { Project } from "ts-morph";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { Workspace } from "../../../analysis/workspace";
import {
	canLink,
	cleanupScratchRoots,
	scratchRepo,
	trackScratchRoot,
} from "../helpers/onDisk";

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

function scratch(files: Record<string, string>): string {
	return scratchRepo(files, { prefix: "ppo-link-", real: true });
}

const LINKS_WORK = canLink();

function link(root: string, from: string, to: string): void {
	const linkPath = path.join(root, from);
	fs.mkdirSync(path.dirname(linkPath), { recursive: true });
	fs.symlinkSync(path.join(root, to), linkPath, "junction");
}

/**
 * A second spelling of `root`: a link beside it that points at it.
 *
 * The only portable way to hand the workspace a root whose `realpath` is a
 * different string — the mismatch macOS produces for free with `/var` versus
 * `/private/var`, and Windows produces whenever a repository is reached through
 * a junction or a `subst` drive.
 */
function aliasOf(root: string): string {
	const alias = path.join(path.dirname(root), `${path.basename(root)}-alias`);
	fs.symlinkSync(root, alias, "junction");
	trackScratchRoot(alias);
	return alias;
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
	cleanupScratchRoots();
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
		//
		// The root the workspace is given here is a *link* to the fixture, so the
		// two spellings really do differ — `path.join(root, "..", basename(root))`
		// normalises straight back to `root` and exercises nothing.
		const root = scratch(MONOREPO);
		link(root, "node_modules/@acme/ui", "packages/ui");
		const alias = aliasOf(root);
		const ws = Workspace.acquire({ projectRoot: alias });

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
		const ws = Workspace.acquire({ projectRoot: root });
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
		const ws = Workspace.acquire({ projectRoot: root });
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

describe.skipIf(!LINKS_WORK)("linked package subpaths", () => {
	const TSCONFIG = {
		compilerOptions: { jsx: "react-jsx", target: "ES2022" },
		include: ["apps"],
	};

	function component(name: string): string {
		return `export function ${name}() { return <b data-testid="${name}" />; }\n`;
	}

	function app(...imports: string[]): string {
		return `${imports.join("\n")}\nexport default function App() { return <div />; }\n`;
	}

	function resolveFrom(root: string, name: string) {
		const ws = Workspace.acquire({ projectRoot: root });
		const entry = ws.project.getSourceFileOrThrow(
			path.join(root, "apps", "web", "src", "App.tsx"),
		);
		return { ws, resolution: resolveIdentifier(ws.project, entry, name) };
	}

	// A `paths` alias aimed straight at `node_modules/<workspace-pkg>` is
	// admitted — the link leads back into the repository — but loading it under
	// the link spelling puts the file in the project as `node_modules/…`, which
	// `sourceFiles()` drops. Its ids reach the tree and never the inventory.
	it("loads a `paths` alias into a linked package under its real path", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					...TSCONFIG.compilerOptions,
					baseUrl: ".",
					paths: { "@acme/ui/*": ["node_modules/@acme/ui/src/*"] },
				},
				include: TSCONFIG.include,
			}),
			"packages/ui/package.json": JSON.stringify({ name: "@acme/ui" }),
			"packages/ui/src/Button.tsx": component("Button"),
			"apps/web/src/App.tsx": app('import { Button } from "@acme/ui/Button";'),
		});
		link(root, "node_modules/@acme/ui", "packages/ui");

		const { ws, resolution } = resolveFrom(root, "Button");
		expect(resolution.resolved).toBe(true);
		if (resolution.resolved) {
			expect(ws.rel(resolution.sourceFile.getFilePath())).toBe(
				"packages/ui/src/Button.tsx",
			);
			expect(ws.analysable(resolution.sourceFile)).toBe(true);
		}
	});

	// `<package>/Button` is not a file in a package that publishes its subpaths
	// through `exports`, so the component was reported as an external dependency
	// of the repository that owns it.
	it("resolves a subpath the package declares through `exports`", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify(TSCONFIG),
			"packages/ui/package.json": JSON.stringify({
				name: "@acme/ui",
				exports: {
					"./Button": {
						source: "./src/Button.tsx",
						default: "./dist/Button.js",
					},
					"./*": "./src/*.tsx",
				},
			}),
			"packages/ui/src/Button.tsx": component("Button"),
			"packages/ui/src/Card.tsx": component("Card"),
			"apps/web/src/App.tsx": app(
				'import { Button } from "@acme/ui/Button";',
				'import { Card } from "@acme/ui/Card";',
			),
		});
		link(root, "node_modules/@acme/ui", "packages/ui");

		const { ws, resolution } = resolveFrom(root, "Button");
		expect(resolution.resolved).toBe(true);
		if (resolution.resolved) {
			expect(ws.rel(resolution.sourceFile.getFilePath())).toBe(
				"packages/ui/src/Button.tsx",
			);
		}
		// And through the `./*` pattern, which is how most design systems say it.
		const card = resolveFrom(root, "Card");
		expect(card.resolution.resolved).toBe(true);
		if (card.resolution.resolved) {
			expect(card.ws.rel(card.resolution.sourceFile.getFilePath())).toBe(
				"packages/ui/src/Card.tsx",
			);
		}
	});

	// `{"import": {"types": …, "default": …}}` is how nearly every published
	// package spells its entry today, and a reader that only understood a string
	// value saw nothing there at all. The source sits at a name no conventional
	// layout would guess, so the table is the only way to reach it.
	it("reads a target nested under a condition object", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify(TSCONFIG),
			"packages/ui/package.json": JSON.stringify({
				name: "@acme/ui",
				exports: {
					".": {
						import: { types: "./dist/index.d.ts", default: "./src/entry.tsx" },
					},
				},
			}),
			"packages/ui/src/entry.tsx": component("Gapped"),
			"apps/web/src/App.tsx": app('import { Gapped } from "@acme/ui";'),
		});
		link(root, "node_modules/@acme/ui", "packages/ui");

		const { ws, resolution } = resolveFrom(root, "Gapped");
		expect(resolution.resolved).toBe(true);
		if (resolution.resolved) {
			expect(ws.rel(resolution.sourceFile.getFilePath())).toBe(
				"packages/ui/src/entry.tsx",
			);
		}
	});

	// A fallback array is a list of candidates, and the engine already tries a
	// list of candidates. The two just never met.
	it("tries every target of a fallback array", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify(TSCONFIG),
			"packages/ui/package.json": JSON.stringify({
				name: "@acme/ui",
				exports: {
					"./Button": ["./src/legacy/Button.tsx", "./src/Button.tsx"],
				},
			}),
			"packages/ui/src/Button.tsx": component("Button"),
			"apps/web/src/App.tsx": app('import { Button } from "@acme/ui/Button";'),
		});
		link(root, "node_modules/@acme/ui", "packages/ui");

		const { ws, resolution } = resolveFrom(root, "Button");
		expect(resolution.resolved).toBe(true);
		if (resolution.resolved) {
			expect(ws.rel(resolution.sourceFile.getFilePath())).toBe(
				"packages/ui/src/Button.tsx",
			);
		}
	});

	/**
	 * The two spellings a design system reaches for when it has nothing to say
	 * about conditions at all.
	 *
	 * `resolve.exports` allows `default` in *every* call — `unsafe` only stops it
	 * adding an implicit `import`/`require` and `node`/`browser` — so the
	 * condition-less pass answers these, and the fan-out's job is to hold that
	 * answer back until the conditional passes have had their turn rather than to
	 * ask for it by name.
	 */
	it("resolves a subpath whose only target is the default", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify(TSCONFIG),
			"packages/ui/package.json": JSON.stringify({
				name: "@acme/ui",
				exports: {
					"./Button": "./src/Button.tsx",
					"./Card": { default: "./src/Card.tsx" },
				},
			}),
			"packages/ui/src/Button.tsx": component("Button"),
			"packages/ui/src/Card.tsx": component("Card"),
			"apps/web/src/App.tsx": app(
				'import { Button } from "@acme/ui/Button";',
				'import { Card } from "@acme/ui/Card";',
			),
		});
		link(root, "node_modules/@acme/ui", "packages/ui");

		for (const name of ["Button", "Card"]) {
			const { ws, resolution } = resolveFrom(root, name);
			expect(resolution.resolved, name).toBe(true);
			if (resolution.resolved) {
				expect(ws.rel(resolution.sourceFile.getFilePath())).toBe(
					`packages/ui/src/${name}.tsx`,
				);
			}
		}
	});

	// And the ordering that holding it back buys: `default` names a build output
	// this engine would happily read as source, so it has to stay behind the
	// unbuilt file the `import` condition points at.
	it("offers the import condition's source ahead of a default build output", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify(TSCONFIG),
			"packages/ui/package.json": JSON.stringify({
				name: "@acme/ui",
				exports: {
					"./Button": {
						import: "./src/Button.tsx",
						default: "./lib/Button.js",
					},
				},
			}),
			"packages/ui/lib/Button.js":
				"export function Button() { return null; }\n",
			"packages/ui/src/Button.tsx": component("Button"),
			"apps/web/src/App.tsx": app('import { Button } from "@acme/ui/Button";'),
		});
		link(root, "node_modules/@acme/ui", "packages/ui");

		const { ws, resolution } = resolveFrom(root, "Button");
		expect(resolution.resolved).toBe(true);
		if (resolution.resolved) {
			expect(ws.rel(resolution.sourceFile.getFilePath())).toBe(
				"packages/ui/src/Button.tsx",
			);
		}
	});

	// A CommonJS-only package says `require`, and the condition set simply did
	// not list it.
	it("reads a `require` condition", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify(TSCONFIG),
			"packages/ui/package.json": JSON.stringify({
				name: "@acme/ui",
				exports: { "./Button": { require: "./src/Button.tsx" } },
			}),
			"packages/ui/src/Button.tsx": component("Button"),
			"apps/web/src/App.tsx": app('import { Button } from "@acme/ui/Button";'),
		});
		link(root, "node_modules/@acme/ui", "packages/ui");

		const { resolution } = resolveFrom(root, "Button");
		expect(resolution.resolved).toBe(true);
	});

	// `null` is the one thing in an `exports` table that means "no". The file is
	// right there and the plain join would have found it, which is exactly why
	// the table has to be believed.
	it("refuses a subpath the package blocks with `null`", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify(TSCONFIG),
			"packages/ui/package.json": JSON.stringify({
				name: "@acme/ui",
				exports: { "./internal/*": null, "./*": "./src/*.tsx" },
			}),
			"packages/ui/internal/Secret.tsx": component("Secret"),
			"packages/ui/src/Card.tsx": component("Card"),
			"apps/web/src/App.tsx": app(
				'import { Secret } from "@acme/ui/internal/Secret";',
				'import { Card } from "@acme/ui/Card";',
			),
		});
		link(root, "node_modules/@acme/ui", "packages/ui");

		const { resolution } = resolveFrom(root, "Secret");
		expect(resolution.resolved).toBe(false);
		if (!resolution.resolved && resolution.external) {
			// Blocked, not built: the package publishes nothing here at all.
			expect(resolution.module).toBe("@acme/ui/internal/Secret");
		}
		// And the sibling pattern the same table declares still resolves, so this
		// is a refusal of one subpath rather than of the package.
		const card = resolveFrom(root, "Card");
		expect(card.resolution.resolved).toBe(true);
		if (card.resolution.resolved) {
			expect(card.ws.rel(card.resolution.sourceFile.getFilePath())).toBe(
				"packages/ui/src/Card.tsx",
			);
		}
	});

	// The subpath used to skip the build-output gate the package root goes
	// through, so a node in the tree could come from a file `sourceFiles()`
	// excludes — and coverage would then call every selector for it dead.
	it("refuses a subpath that lands in the package's build output", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify(TSCONFIG),
			"packages/ui/package.json": JSON.stringify({ name: "@acme/ui" }),
			"packages/ui/dist/Button.tsx": component("Button"),
			"apps/web/src/App.tsx": app(
				'import { Button } from "@acme/ui/dist/Button";',
			),
		});
		link(root, "node_modules/@acme/ui", "packages/ui");

		const { ws, resolution } = resolveFrom(root, "Button");
		expect(resolution.resolved).toBe(false);
		if (!resolution.resolved && resolution.external) {
			expect(resolution.module).toBe("@acme/ui/dist/Button (built output)");
		}
		expect(
			ws.project
				.getSourceFiles()
				.map((file) => toPosix(file.getFilePath()))
				.filter((file) => file.includes("/dist/")),
		).toEqual([]);
	});

	// A probe outcome is a statement about the files as they were. Cached for the
	// life of the process, the first "this package has no source" answer outlived
	// every edit that made it false.
	it("re-probes a linked package after the workspace revalidates", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify(TSCONFIG),
			"packages/ui/package.json": JSON.stringify({
				name: "@acme/ui",
				source: "src/index.tsx",
			}),
			"apps/web/src/App.tsx": app('import { Gapped } from "@acme/ui";'),
		});
		link(root, "node_modules/@acme/ui", "packages/ui");
		const ws = Workspace.acquire({ projectRoot: root, staleAfterMs: 0 });
		const entry = path.join(root, "apps", "web", "src", "App.tsx");
		const first = resolveIdentifier(
			ws.project,
			ws.project.getSourceFileOrThrow(entry),
			"Gapped",
		);
		expect(first.resolved).toBe(false);

		fs.mkdirSync(path.join(root, "packages", "ui", "src"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "packages", "ui", "src", "index.tsx"),
			component("Gapped"),
			"utf8",
		);
		// An edit in the analysed scope is what makes the sweep bump the epoch —
		// the same thing an agent editing both halves of a monorepo does.
		const when = new Date(Date.now() + 5000);
		fs.utimesSync(entry, when, when);
		ws.revalidate();

		const second = resolveIdentifier(
			ws.project,
			ws.project.getSourceFileOrThrow(entry),
			"Gapped",
		);
		expect(second.resolved).toBe(true);
		if (second.resolved) {
			expect(ws.rel(second.sourceFile.getFilePath())).toBe(
				"packages/ui/src/index.tsx",
			);
		}
	});
});

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
		const ws = Workspace.acquire({
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
		const ws = Workspace.acquire({
			projectRoot: path.join(root, "apps", "web"),
		});

		const tree = buildTestIdTree(ws);
		expect(tree.externalModules).toEqual(["@acme/ui"]);
		// No scope change reaches a published package, so promising one would be
		// advice that cannot be followed.
		expect(tree.externalModuleRoot).toBeUndefined();
	});
});
