export type ToolErrorCode =
	| "invalid_input"
	| "class_not_found"
	| "ambiguous_class"
	| "ambiguous_component"
	| "incomplete_tree"
	| "file_not_found"
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
