export type ToolErrorCode =
	| "invalid_input"
	| "class_not_found"
	| "ambiguous_class"
	| "ambiguous_component"
	| "incomplete_tree"
	| "file_not_found"
	// A *component* the scan does not declare. Distinct from `file_not_found`,
	// which these used to borrow: the message said "No component named X was
	// found" under a code naming a file, so the two halves of one error
	// disagreed about what was missing.
	| "component_not_found"
	| "parse_error"
	// Recoverable by construction: the model re-calls the creation tool and
	// gets a fresh handle. See `src/mcp/handles.ts`.
	| "expired_handle"
	| "too_large"
	| "max_files_exceeded"
	| "internal_error";

/**
 * Recoverable, in-band tool failure. Carries a machine-readable code plus a
 * `hint` phrased so the calling agent can self-correct (e.g. "call
 * list_page_objects"). Never let these escape as JSON-RPC protocol errors.
 */
export class ToolError extends Error {
	readonly code: ToolErrorCode;
	readonly hint?: string;
	readonly candidates?: string[];
	readonly suggestions?: string[];

	constructor(
		code: ToolErrorCode,
		message: string,
		extras?: { hint?: string; candidates?: string[]; suggestions?: string[] },
	) {
		super(message);
		this.name = "ToolError";
		this.code = code;
		this.hint = extras?.hint;
		this.candidates = extras?.candidates;
		this.suggestions = extras?.suggestions;
	}
}

/**
 * Picks the wording that matches what the payload actually carries.
 *
 * Three call sites computed a suggestion list that can legitimately come back
 * empty, and told the reader "use one of the suggested paths" either way — an
 * instruction to read something that was not sent. It was fixed at one of them
 * and the audit promptly hit another, so the choice lives here now: pass both
 * wordings and the list decides, and a fourth site cannot get it wrong.
 */
export function hintForSuggestions(
	suggestions: string[] | undefined,
	wording: { some: string; none: string },
): string {
	return suggestions && suggestions.length > 0 ? wording.some : wording.none;
}
