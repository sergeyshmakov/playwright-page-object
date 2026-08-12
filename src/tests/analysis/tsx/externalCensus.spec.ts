import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildCoverageReport } from "../../../analysis/coverage/mapCoverage";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import { Workspace } from "../../../analysis/workspace";
import { canLink, cleanupScratchRoots, scratchRepo } from "../helpers/onDisk";

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

function scratch(files: Record<string, string>): string {
	return scratchRepo(files, { prefix: "ppo-census-", real: true });
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
	cleanupScratchRoots();
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

	/**
	 * The linked/installed verdict is per importing directory, so the count of
	 * linked specifiers has to be taken over all of them.
	 *
	 * Probing a fixed sample made `linkedCount` a floor rather than a count, and
	 * worse, narrowed `sourceRoot` - the one directory the "re-root here" remedy
	 * names - to the sources those samples happened to reach. This module states
	 * the rule it was breaking a few lines from the code: a capped list is fine;
	 * a capped number is a false statement.
	 */
	it("finds a link visible only from the last of many importers", () => {
		// The sources live *outside* the project root, which is what the
		// linked/installed split is about: `--project-root` is `repo`, and the
		// design system sits beside it. Five importers have an installed copy; the
		// sixth links to those outside sources. With a fixed sample of four the
		// sixth was never probed, so the specifier read as installed-only and the
		// remedy lost the one directory it can name.
		const importers = 6;
		const files: Record<string, string> = {
			"shared/ui/package.json": JSON.stringify({
				name: "@acme/ui",
				source: "src/index.tsx",
			}),
			"shared/ui/src/index.tsx": [
				"export function Gapped({ children }: { children?: unknown }) {",
				'\treturn <div data-testid="GappedRoot">{children as never}</div>;',
				"}",
				"",
			].join("\n"),
			"repo/tsconfig.json": JSON.stringify({
				compilerOptions: { jsx: "react-jsx", target: "ES2022" },
				include: ["packages"],
			}),
		};
		for (let index = 0; index < importers; index += 1) {
			files[`repo/packages/app${index}/src/View.tsx`] = [
				'import { Gapped } from "@acme/ui";',
				`export default function View${index}() {`,
				`\treturn <Gapped><span data-testid="Inner${index}" /></Gapped>;`,
				"}",
				"",
			].join("\n");
			if (index < importers - 1) {
				files[`repo/packages/app${index}/node_modules/@acme/ui/package.json`] =
					JSON.stringify({ name: "@acme/ui", main: "index.js" });
				files[`repo/packages/app${index}/node_modules/@acme/ui/index.js`] =
					"module.exports = {};";
			}
		}
		const outer = scratch(files);
		link(
			outer,
			`repo/packages/app${importers - 1}/node_modules/@acme/ui`,
			"shared/ui",
		);
		const ws = Workspace.acquire({
			projectRoot: path.join(outer, "repo"),
		});

		// The scope warning lives on the coverage report, which is where the
		// linked/installed split is turned into advice.
		const report = buildCoverageReport(ws);
		const scope = report.warnings.find(
			(warning) => warning.code === "ui-scope-incomplete",
		);
		expect(scope).toBeDefined();
		expect(scope?.message).toContain("@acme/ui");
		// The half that only the sixth importer can see: the link onto in-repo
		// sources, and the directory to re-root at. Without it the message says
		// the opposite - that no scanning scope reaches them.
		expect(scope?.message).toContain("onto sources in this repository");
		expect(scope?.message).toContain("re-run with the analysis rooted at");
	});
});
