import {
	type ComponentInfo,
	nearestIds,
	nearestNames,
	type PageObjectSummary,
} from "../../analysis";
import { hintForSuggestions, ToolError } from "../errors";
import { MAX_ERROR_LIST } from "../respond";
import { isScannedFile } from "./paths";

const EMPTY_INDEX_HINT =
	'No classes with playwright-page-object decorators were found. If your page objects live elsewhere, restart the server with --src-dir <dir>; also check that those files import from "playwright-page-object".';

/**
 * What to say when the page came back empty.
 *
 * Three different situations produced the same "nothing was found" message, and
 * two of them were the caller's own arguments rather than the repository: a
 * filter that matched none of 305 page objects, and an offset past the end.
 * Telling either of those callers to restart the server with `--src-dir` sends
 * them to reconfigure a server that is working correctly.
 */
export function listEmptyHint(
	filter: string | undefined,
	offset: number,
	total: number,
	indexed: PageObjectSummary[],
): string | undefined {
	if (indexed.length === 0) {
		return EMPTY_INDEX_HINT;
	}
	if (total === 0) {
		const nearest = nearestIds(
			filter ?? "",
			indexed.map((item) => item.className),
			5,
		);
		const suggestion =
			nearest.length > 0 ? ` Closest names: ${nearest.join(", ")}.` : "";
		return `No page object matches filter "${filter}", but the index holds ${indexed.length}. Drop or widen the filter — it is a plain case-insensitive substring of the class name or file path.${suggestion}`;
	}
	return `offset ${offset} is past the end of ${total} result(s); re-call with a smaller offset.`;
}

/** What a `testId` lookup should say beyond the occurrence list itself. */
export function lookupHint(
	needle: string,
	found: number,
	catchAllSkipped: number,
	propOnly: boolean,
	families: string[] = [],
): string | undefined {
	if (found === 0) {
		const quarantined =
			catchAllSkipped > 0
				? ` ${catchAllSkipped} element(s) do write the attribute with a value built entirely at runtime, which would match any id and so proves nothing about this one; they are excluded.`
				: "";
		// The one true-negative that reads like a bug. A `@ListSelector("Row")`
		// matches ids rendered as `Row_1`, `Row_2`, ... and coverage counts it
		// matched, while looking the bare prefix up is correctly empty — nothing
		// renders `Row` itself. Saying only "not found" invites the reader to
		// conclude the selector is broken.
		if (families.length > 0) {
			// The example is built from a family, not from the needle. `${needle}_0`
			// only happens to exist when the separator is `_` and the needle is the
			// whole prefix; for `Row-${i}`, or for a partial needle, it named an id
			// nothing renders and cost the reader a second empty lookup.
			const example = `${(families[0] ?? "").replace(/\*$/, "")}0`;
			return `No element renders the exact id "${needle}", but ${families.length === 1 ? "an id family" : "id families"} built on it ${families.length === 1 ? "does" : "do"}: ${families.join(", ")}. A prefix selector such as @ListSelector("${needle}") matches those and is not dead. Look up a concrete one (for example "${example}"), or call get_testid_tree on the component to see them in place.`;
		}
		return `No rendered element with test id "${needle}" was found.${quarantined} Call get_testid_tree without testId to see the full tree, or map_coverage to check for renamed ids.`;
	}
	if (propOnly) {
		return `Every occurrence of "${needle}" is written as a prop on a component tag, and nothing proved the component forwards it to a host element. It may not exist in the DOM at all; check the component before writing a selector for it.`;
	}
	return undefined;
}

/**
 * What to say when `component` named nothing.
 *
 * Three mistakes wear the same error code, and each has a different list that
 * answers it. The name exists but not in the file that was named: the files
 * that *do* declare it are the fix, and they go in `candidates` — the same
 * answer the page-object side gives for `path.ts#ClassName` against the wrong
 * file. The name exists nowhere and a file was named: that file's own
 * components are the fix, and the whole list is short enough to be the answer.
 * The name exists nowhere and no file was named: ranking is all there is, since
 * dumping every component in the repository buries the one that matters.
 *
 * The list used to be empty in all three, which is how a one-character typo
 * became a dead end.
 */
export function missingComponent(
	wanted: string,
	scopeFile: string | undefined,
	sameName: ComponentInfo[],
	all: ComponentInfo[],
): ToolError {
	if (scopeFile && sameName.length > 0) {
		return new ToolError(
			"component_not_found",
			`No component named "${wanted}" is declared in "${scopeFile}", but ${sameName.length} other file(s) declare it.`,
			{
				candidates: sameName.map((component) => component.file).sort(),
				hint: "Re-call with `file` set to one of the candidates, or drop `file` to search every scanned file.",
			},
		);
	}

	if (!scopeFile) {
		const suggestions = nearestNames(
			wanted,
			all.map((component) => component.name),
			MAX_ERROR_LIST,
		);
		return new ToolError(
			"component_not_found",
			`No component named "${wanted}" was found in the scanned sources.`,
			{
				suggestions,
				hint: hintForSuggestions(suggestions, {
					some: "Pass one of the suggested names, pass `file` with the component's path, or omit both to auto-detect the app entry.",
					none: "Nothing in the scan resembles that name. Pass `file` with the component's path, omit both to auto-detect the app entry, or pass `testId` to find where a known id is rendered.",
				}),
			},
		);
	}

	const inFile = [
		...new Set(
			all
				.filter((component) => isScannedFile(component.file, scopeFile))
				.map((component) => component.name),
		),
	].sort();
	return new ToolError(
		"component_not_found",
		inFile.length === 0
			? `"${scopeFile}" declares no components.`
			: `No component named "${wanted}" is declared in "${scopeFile}".`,
		{
			suggestions: inFile,
			hint: hintForSuggestions(inFile, {
				some: "Pass one of the suggested names, drop `file` to search every scanned file, or omit both to auto-detect the app entry.",
				none: "Pass `file` with the path of a file that declares a component, or omit both to auto-detect the app entry.",
			}),
		},
	);
}
