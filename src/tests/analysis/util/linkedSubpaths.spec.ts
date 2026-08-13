import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { toPosix } from "../../../analysis/util/paths";
import { resolveIdentifier } from "../../../analysis/util/resolve";
import { LINKS_WORK, link, pool, scratch } from "../helpers/linkedWorkspace";

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
		const ws = pool.acquire({ projectRoot: root });
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
		const ws = pool.acquire({ projectRoot: root, staleAfterMs: 0 });
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
