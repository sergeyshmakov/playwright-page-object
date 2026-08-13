import * as path from "node:path";
import {
	entryFileCandidates,
	matchEntryPath,
	nearestFiles,
	normalizeRelPath,
	type Workspace,
} from "../analysis";
import { hintForSuggestions, ToolError } from "./errors";
import { foldFile } from "./present/paths";

/**
 * Turning the file a caller named into the scanned path the engine emitted,
 * or a not-found error that says what was searched.
 *
 * The opposite direction from `present/paths.ts`, which compares two paths the
 * engine itself produced.
 */

/** Characters that make a value look like an absolute path on either OS. */
export function isAbsoluteLike(value: string): boolean {
	return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Accepts an absolute path that points inside the project, and refuses one that
 * does not.
 *
 * Agents paste the path their editor shows them. Treating
 * `C:\repo\e2e\Home.ts` as a relative path made it match nothing and produced
 * `file_not_found` with a list of relative suggestions — technically correct,
 * unactionable in practice. A path outside the root is a different mistake and
 * gets a different answer rather than a silent miss.
 */
export function relativizeFile(
	workspace: Workspace,
	file: string,
): { file: string; note?: string } {
	if (!isAbsoluteLike(file)) {
		return { file };
	}
	const root = normalizeRelPath(workspace.root).replace(/\/+$/, "");
	const posix = normalizeRelPath(file);
	if (foldFile(posix) === foldFile(root)) {
		throw new ToolError("invalid_input", `"${file}" is the project root.`, {
			hint: "Pass the path of a file, relative to the project root.",
		});
	}
	if (foldFile(posix).startsWith(`${foldFile(root)}/`)) {
		const relative = posix.slice(root.length + 1);
		return {
			file: relative,
			note: `\`file\` was given as an absolute path and read as "${relative}", relative to the project root.`,
		};
	}
	throw new ToolError(
		"invalid_input",
		`"${file}" is outside the analysed project root (${root}).`,
		{
			hint: "Paths are workspace-relative. Pass the path exactly as list_page_objects reports it, or restart the server with --project-root covering that file.",
		},
	);
}

/**
 * The `file` argument, resolved to the path the walk will root at.
 *
 * `TestIdTreeOptions.entry` is a path the engine looks for among the scanned
 * JSX sources, and a path that matches none of them is not an error down there:
 * the walk reports `entry-not-found` and falls back to a flat inventory of the
 * whole scan. Through this tool that reads as "your scope was ignored, here is
 * the entire repository" — one typo'd `file` in the field produced a `too_large`
 * failure whose advice was to scope the call with `file`, which the caller had
 * already done. So the same resolve-then-refuse the other two tools apply to
 * their `file` argument happens here, against the very set the engine searches.
 *
 * Through {@link matchEntryPath}, which is the engine's own rule rather than a
 * copy of it: exact path first, a trailing segment only when it fits one file.
 * A `.find()` over the same candidates accepted whichever suffix match sorted
 * first, so `src/App.tsx` could be answered with `packages/ui/src/App.tsx` — and
 * because this wrapper rewrites the request, the engine's corrected resolver
 * never saw the path the caller actually wrote.
 */
export function resolveEntryFile(
	workspace: Workspace,
	file: string,
): { file: string; note?: string } {
	const resolved = relativizeFile(workspace, file);
	const candidates = entryFileCandidates(workspace);
	const match = matchEntryPath(candidates, resolved.file);
	if (match.kind === "ambiguous") {
		throw new ToolError(
			"ambiguous_component",
			`"${file}" names only a trailing path segment, and ${match.candidates.length} scanned files end with it.`,
			{
				candidates: match.candidates,
				hint: "Re-call with `file` set to one of the candidates, spelled relative to the project root.",
			},
		);
	}
	if (match.kind === "none") {
		const suggestions = nearestFiles(resolved.file, candidates);
		const scopeAdvice =
			"Only scanned .tsx/.jsx sources can root a tree: if the file is on disk but outside the scan, restart the server with --src-dir <dir> (or --project-root <dir>) covering it.";
		throw new ToolError(
			"file_not_found",
			`No scanned .tsx/.jsx source matches "${file}".`,
			{
				suggestions,
				hint: hintForSuggestions(suggestions, {
					some: `Use one of the suggested paths, or pass \`component\` and let the server find the file. ${scopeAdvice}`,
					none: `Nothing in the scan resembles that path. Pass \`component\` and let the server find the file, or pass \`testId\` to find where a known id is rendered. ${scopeAdvice}`,
				}),
			},
		);
	}
	// The scanned spelling, not the caller's: it is what `component` is filtered
	// against below, and what the engine will match without a suffix search.
	return { file: match.file, note: resolved.note };
}
