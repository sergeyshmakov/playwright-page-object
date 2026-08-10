import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import { Workspace } from "../../../analysis/workspace";

/**
 * Which modules the scanned sources do not contain.
 *
 * A bare specifier resolves from the *importing* file: the resolver walks up
 * from its directory looking for `node_modules/<pkg>`, so one specifier has as
 * many answers as there are places it is imported from. Caching the answer
 * under the specifier alone let the first file scanned decide for every other
 * one, and in a monorepo where one package links the design system to its own
 * sources and another has an installed copy, that answer is wrong for half the
 * repository — either inventing an external boundary around first-party code,
 * or hiding a real one.
 *
 * Real filesystem, because ts-morph's in-memory host models no links at all.
 */

const roots: string[] = [];

function scratch(files: Record<string, string>): string {
	const root = fs.realpathSync.native(
		fs.mkdtempSync(path.join(os.tmpdir(), "ppo-census-")),
	);
	roots.push(root);
	for (const [relativePath, contents] of Object.entries(files)) {
		const absolute = path.join(root, relativePath);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, contents, "utf8");
	}
	return root;
}

/** A directory junction on Windows, an ordinary directory symlink elsewhere. */
function canLink(): boolean {
	const probe = fs.mkdtempSync(path.join(os.tmpdir(), "ppo-censusprobe-"));
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

/**
 * `packages/web` links `@acme/ui` to the repository's own package;
 * `packages/api` has an installed copy of the same name. Both render `<Gapped>`
 * from the same specifier, and only one of them is outside the sources.
 */
const SPLIT_MONOREPO = {
	"tsconfig.json": JSON.stringify({
		compilerOptions: { jsx: "react-jsx", target: "ES2022" },
		include: ["packages"],
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
	"packages/web/src/App.tsx": [
		'import { Gapped } from "@acme/ui";',
		"export default function App() {",
		'\treturn <Gapped><span data-testid="WebInner" /></Gapped>;',
		"}",
		"",
	].join("\n"),
	"packages/api/src/Panel.tsx": [
		'import { Gapped } from "@acme/ui";',
		"export default function Panel() {",
		'\treturn <Gapped><span data-testid="ApiInner" /></Gapped>;',
		"}",
		"",
	].join("\n"),
	"packages/api/node_modules/@acme/ui/package.json": JSON.stringify({
		name: "@acme/ui",
		main: "index.js",
	}),
	"packages/api/node_modules/@acme/ui/index.js": "module.exports = {};",
};

beforeEach(() => {
	Workspace.reset();
});

afterAll(() => {
	for (const root of roots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe.skipIf(!LINKS_WORK)("external module census", () => {
	it("resolves one specifier per importing file", () => {
		const root = scratch(SPLIT_MONOREPO);
		link(root, "packages/web/node_modules/@acme/ui", "packages/ui");
		const ws = Workspace.acquire({ projectRoot: root });

		const tree = buildTestIdTree(ws, { entry: "packages/web/src/App.tsx" });

		// Exactly the one tag that really is outside the sources. Cached by
		// specifier, whichever file was scanned first answered for both: two
		// external tags, or none.
		expect(tree.stats.externalComponentTags).toBe(1);
		expect(tree.externalModules).toEqual(["@acme/ui"]);
		// And the linked half is still walked as the first-party source it is.
		expect(tree.roots[0].tag).toBe("Gapped");
		expect(tree.roots[0].unresolved).toBeUndefined();
	});
});
