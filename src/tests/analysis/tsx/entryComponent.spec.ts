import { describe, expect, it } from "vitest";
import { staticId } from "../../../analysis";
import type { TestIdTreeOptions } from "../../../analysis/tsx/tree";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import { makeWorkspace } from "../helpers/inMemory";

/**
 * Rooting a tree at a named declaration.
 *
 * Without it the engine could only answer with a file's *first* (or
 * default-exported) component, and every caller that knew which component it
 * wanted had to re-derive the answer from a tree rooted somewhere else — or be
 * told the component was "not rendered" when it simply was not the first one.
 */

const BOTH = {
	"src/Both.tsx": [
		'export function Alpha() { return <div data-testid="AlphaBox" />; }',
		'export function Beta() { return <div data-testid="BetaBox" />; }',
	].join("\n"),
};

function treeFor(files: Record<string, string>, options: TestIdTreeOptions) {
	return buildTestIdTree(makeWorkspace(files), options);
}

describe("entryComponent", () => {
	it("roots at the named declaration rather than the file's first", () => {
		const tree = treeFor(BOTH, {
			entry: "src/Both.tsx",
			entryComponent: "Beta",
		});
		expect(tree.fidelity).toBe("full");
		expect(tree.roots[0].component).toBe("Beta");
		expect(tree.roots[0].testId).toMatchObject({ value: "BetaBox" });
	});

	it("still roots at the first component when no name is given", () => {
		const tree = treeFor(BOTH, { entry: "src/Both.tsx" });
		expect(tree.roots[0].component).toBe("Alpha");
	});

	it("resolves an anonymous default export by its file basename", () => {
		// `declaredNameOf` reports the basename for a nameless default export, so
		// that is the name `components[]` carries and the name a caller can pass —
		// even though no declaration in the file is literally called "Foo".
		const tree = treeFor(
			{ "src/Foo.tsx": 'export default () => <div data-testid="FooBox" />;' },
			{ entry: "src/Foo.tsx", entryComponent: "Foo" },
		);
		expect(tree.fidelity).toBe("full");
		expect(tree.roots[0].testId).toMatchObject({ value: "FooBox" });
	});

	it("names the declarations it does have when the requested one is missing", () => {
		const tree = treeFor(BOTH, {
			entry: "src/Both.tsx",
			entryComponent: "Gamma",
		});
		expect(tree.fidelity).toBe("flat");
		expect(tree.fidelityReason).toContain("Gamma");
		expect(tree.fidelityReason).toContain("Alpha");
		expect(tree.fidelityReason).toContain("Beta");
		// The inventory is untouched: coverage runs off it, not off the tree.
		expect(tree.inventory.map((entry) => staticId(entry.value)).sort()).toEqual(
			["AlphaBox", "BetaBox"],
		);
	});

	it("guesses nothing when no entry file was given", () => {
		const tree = treeFor(BOTH, { entryComponent: "Beta" });
		// A component name is only unique per file. Searching every file would
		// answer with whichever was scanned first, which is a guess wearing a
		// precise-looking name.
		expect(tree.fidelity).toBe("flat");
		expect(tree.fidelityReason).toContain("entry file");
	});

	it("follows a barrel re-export to the declaring file", () => {
		const tree = treeFor(
			{
				"src/index.tsx": 'export { Beta } from "./Beta";',
				"src/Beta.tsx":
					'export function Beta() { return <div data-testid="BetaBox" />; }',
			},
			{ entry: "src/index.tsx", entryComponent: "Beta" },
		);
		expect(tree.fidelity).toBe("full");
		expect(tree.roots[0].file).toBe("src/Beta.tsx");
		expect(tree.roots[0].testId).toMatchObject({ value: "BetaBox" });
	});
});

/**
 * Which file an `entry` names.
 *
 * A trailing segment is accepted as a convenience, and it used to compete with
 * the exact path in one pass: whichever spelling a file happened to sort under
 * first won. A monorepo holding `packages/ui/src/App.tsx` answered a request
 * for the documented `src/App.tsx` with the package's component.
 */
describe("entry file matching", () => {
	const MONOREPO = {
		"packages/ui/src/App.tsx": [
			"export default function PkgApp() {",
			'  return <div data-testid="PkgBox" />;',
			"}",
		].join("\n"),
		"src/App.tsx": [
			"export default function RootApp() {",
			'  return <div data-testid="RootBox" />;',
			"}",
		].join("\n"),
	};

	it("prefers the exact path over a suffix match found earlier", () => {
		const tree = treeFor(MONOREPO, { entry: "src/App.tsx" });
		expect(tree.roots[0].file).toBe("src/App.tsx");
		expect(tree.roots[0].testId).toMatchObject({ value: "RootBox" });
	});

	it("still accepts a suffix that names exactly one file", () => {
		const tree = treeFor(MONOREPO, { entry: "ui/src/App.tsx" });
		expect(tree.roots[0].file).toBe("packages/ui/src/App.tsx");
	});

	it("refuses a suffix that fits several files rather than picking one", () => {
		const tree = treeFor(MONOREPO, { entry: "App.tsx" });
		expect(tree.fidelity).toBe("flat");
		expect(tree.fidelityReason).toContain("packages/ui/src/App.tsx");
		expect(tree.fidelityReason).toContain("src/App.tsx");
		expect(tree.warnings.map((diag) => diag.code)).toContain("entry-not-found");
	});
});

describe("the bootstrap file's root element", () => {
	it("takes the outer wrapper, not a self-closing child of it", () => {
		// The two JSX kinds were scanned one list after the other, so every
		// self-closing element was considered before any opening one. In
		// `<Shell><App /></Shell>` that picked `App`: the tree came back rooted at
		// the child, with everything `Shell` renders around it missing — the
		// nesting reported wrong rather than incomplete.
		const tree = treeFor(
			{
				"src/Shell.tsx":
					'export function Shell({ children }) { return <div data-testid="ShellRoot">{children}</div>; }',
				"src/App.tsx":
					'export function App() { return <main data-testid="AppRoot" />; }',
				"src/main.tsx": [
					'import { App } from "./App";',
					'import { Shell } from "./Shell";',
					"export function boot() { return <Shell><App /></Shell>; }",
				].join("\n"),
			},
			{},
		);
		expect(tree.roots.map((root) => staticId(root.testId))).toContain(
			"ShellRoot",
		);
	});
});
