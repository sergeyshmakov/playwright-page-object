import { type SourceFile, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";
import { scanFileElements } from "../../../analysis/tsx/scanTestIds";
import { buildTestIdTree, scannedComponents } from "../../../analysis/tsx/tree";
import { lineAndColumnAt, lineAt } from "../../../analysis/util/position";
import { exampleWorkspace } from "../helpers/example";
import { makeWorkspace, memoryPath } from "../helpers/inMemory";

/**
 * Two hot-path swaps replaced ts-morph APIs with the TypeScript primitives
 * underneath them, on the strength of the results being identical. Nothing in
 * the payload would change if they ever stopped being identical — a line number
 * off by one, an element visited out of order — so these are the assertions that
 * hold the equivalence in place.
 */

/** The traversal `scanFileElements` used to do: two passes plus a sort. */
function openingsTheSlowWay(sourceFile: SourceFile): number[] {
	const openings = [
		...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
		...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
	];
	openings.sort((a, b) => a.getStart() - b.getStart());
	return openings.map((node) => node.getStart());
}

describe("JSX element walk", () => {
	it("visits exactly the elements ts-morph would, in the same order", () => {
		const ws = exampleWorkspace();
		const files = ws.jsxFiles();
		expect(files.length).toBeGreaterThan(0);

		let total = 0;
		for (const sourceFile of files) {
			const expected = openingsTheSlowWay(sourceFile);
			const actual = scanFileElements(
				sourceFile,
				"data-testid",
				ws.rel(sourceFile.getFilePath()),
			).map((element) => element.node.getStart());
			expect(actual, sourceFile.getBaseName()).toEqual(expected);
			total += actual.length;
		}
		expect(total).toBeGreaterThan(0);
	});

	/**
	 * Nesting, fragments, self-closing tags, JSX inside attribute expressions and
	 * inside a `.map()` callback — the shapes where a hand-rolled descent could
	 * plausibly diverge from ts-morph's.
	 */
	it("matches on deeply nested and unusual JSX", () => {
		const ws = makeWorkspace({
			"src/Odd.tsx": [
				"export function Odd({ rows }: { rows: string[] }) {",
				"\treturn (",
				"\t\t<>",
				'\t\t\t<div data-testid="Outer">',
				'\t\t\t\t<Panel header={<span data-testid="InAttribute" />}>',
				"\t\t\t\t\t{rows.map((row) => (",
				'\t\t\t\t\t\t<Row key={row} data-testid={"Row_" + row}>',
				'\t\t\t\t\t\t\t<b data-testid="Bold" />',
				"\t\t\t\t\t\t</Row>",
				"\t\t\t\t\t))}",
				"\t\t\t\t</Panel>",
				"\t\t\t</div>",
				'\t\t\t<img data-testid="Solo" />',
				"\t\t</>",
				"\t);",
				"}",
				"function Panel(props: { header: unknown; children: unknown }) {",
				"\treturn <section>{props.header}{props.children}</section>;",
				"}",
				"",
			].join("\n"),
		});
		const sourceFile = ws.project.getSourceFileOrThrow(
			memoryPath("src/Odd.tsx"),
		);
		const actual = scanFileElements(sourceFile, "data-testid", "src/Odd.tsx");
		expect(actual.map((element) => element.node.getStart())).toEqual(
			openingsTheSlowWay(sourceFile),
		);
		// div, Panel, span, Row, b, img, section — the fragment is not an element.
		expect(actual.length).toBe(7);
	});
});

/**
 * `handleGetTestIdTree` used to build a whole depth-1 tree and read only its
 * `components` field. This is the assertion that let that tree go: the standalone
 * inventory is the same map, entry for entry.
 */
describe("component inventory without a tree", () => {
	it("matches the components field of a full tree", () => {
		const ws = exampleWorkspace();
		expect(scannedComponents(ws)).toEqual(buildTestIdTree(ws).components);
		// And what the probe used to ask for, exactly.
		expect(scannedComponents(ws)).toEqual(
			buildTestIdTree(ws, { maxDepth: 1, followComponents: false }).components,
		);
	});
});

describe("line and column", () => {
	it("agrees with ts-morph at every element in the example app", () => {
		const ws = exampleWorkspace();
		let checked = 0;
		for (const sourceFile of ws.sourceFiles()) {
			for (const node of sourceFile.getDescendants()) {
				const start = node.getStart();
				expect(lineAndColumnAt(sourceFile, start)).toEqual(
					sourceFile.getLineAndColumnAtPos(start),
				);
				checked += 1;
			}
		}
		expect(checked).toBeGreaterThan(1000);
	});

	/**
	 * CRLF is the case where the two implementations can actually disagree, and
	 * the only positions where they do are ones no caller can produce: ts-morph
	 * counts lines by `\n` but measures the column from the nearest `\r` *or*
	 * `\n`, so a position sitting between the two halves of a `\r\n` gets the old
	 * line number with the new line's column. TypeScript treats `\r\n` as one
	 * terminator throughout. Every call site passes a node's `getStart()`, which
	 * is never inside a line terminator — so the assertion is over node starts,
	 * which is the contract that has to hold.
	 */
	it("agrees on CRLF and LF text at every node start", () => {
		const source = [
			"const a = 1;",
			"",
			"export function f() {",
			"\treturn a + 2;",
			"}",
			"",
		];
		const ws = makeWorkspace({
			"src/crlf.ts": source.join("\r\n"),
			"src/lf.ts": source.join("\n"),
		});
		for (const name of ["src/crlf.ts", "src/lf.ts"]) {
			const sourceFile = ws.project.getSourceFileOrThrow(memoryPath(name));
			const nodes = sourceFile.getDescendants();
			expect(nodes.length).toBeGreaterThan(10);
			for (const node of nodes) {
				const start = node.getStart();
				expect(lineAndColumnAt(sourceFile, start), `${name}@${start}`).toEqual(
					sourceFile.getLineAndColumnAtPos(start),
				);
			}
			expect(lineAt(sourceFile, 0)).toBe(1);
			expect(lineAndColumnAt(sourceFile, 0)).toEqual({ line: 1, column: 1 });
		}
	});
});
