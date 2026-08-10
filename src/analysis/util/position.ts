import { type SourceFile, ts } from "ts-morph";

/**
 * One-based line and column for a position in a file.
 *
 * ts-morph's `SourceFile.getLineAndColumnAtPos` rescans the file text from
 * index 0 on every call — two linear passes, one counting newlines and one
 * finding the line start. Every reported location goes through it, so a tree of
 * eleven thousand elements rescans megabytes of text eleven thousand times.
 *
 * TypeScript already keeps a line-start table on the parsed source file and
 * answers the same question with a binary search over it. The numbers are
 * identical — TypeScript's are zero-based, hence the two `+ 1` — and a fixture
 * test asserts that against the ts-morph API it replaces so the two cannot
 * drift.
 *
 * One position disagrees, and cannot be reached: inside a `\r\n`, between the
 * two characters. ts-morph counts the line by `\n` alone but measures the
 * column from the nearest `\r` *or* `\n`, so it reports the old line at column
 * 1; TypeScript treats `\r\n` as a single terminator. Every caller passes a
 * node's `getStart()`, which never lands inside a line terminator.
 */
export function lineAndColumnAt(
	sourceFile: SourceFile,
	pos: number,
): { line: number; column: number } {
	const position = ts.getLineAndCharacterOfPosition(
		sourceFile.compilerNode,
		pos,
	);
	return { line: position.line + 1, column: position.character + 1 };
}

/** One-based line only, for the callers that report nothing else. */
export function lineAt(sourceFile: SourceFile, pos: number): number {
	return (
		ts.getLineAndCharacterOfPosition(sourceFile.compilerNode, pos).line + 1
	);
}
