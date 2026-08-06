import type {
	Diagnostic,
	DiagnosticCode,
	DiagnosticSeverity,
	SourceLoc,
} from "./types";

export type { Diagnostic, DiagnosticCode, DiagnosticSeverity } from "./types";

/**
 * Builds a {@link Diagnostic}. Keeping construction in one place means the
 * `data` bag stays JSON-safe and `undefined` fields never reach the wire.
 */
export function makeDiag(
	code: DiagnosticCode,
	severity: DiagnosticSeverity,
	message: string,
	loc?: SourceLoc,
	data?: Record<string, string | number | boolean | null | undefined>,
): Diagnostic {
	const diag: Diagnostic = { code, severity, message };
	if (loc) {
		diag.loc = loc;
	}
	if (data) {
		const clean: Record<string, string | number | boolean | null> = {};
		for (const [key, value] of Object.entries(data)) {
			if (value !== undefined) {
				clean[key] = value;
			}
		}
		if (Object.keys(clean).length > 0) {
			diag.data = clean;
		}
	}
	return diag;
}

export const info = (
	code: DiagnosticCode,
	message: string,
	loc?: SourceLoc,
	data?: Record<string, string | number | boolean | null | undefined>,
): Diagnostic => makeDiag(code, "info", message, loc, data);

export const warn = (
	code: DiagnosticCode,
	message: string,
	loc?: SourceLoc,
	data?: Record<string, string | number | boolean | null | undefined>,
): Diagnostic => makeDiag(code, "warning", message, loc, data);

export const error = (
	code: DiagnosticCode,
	message: string,
	loc?: SourceLoc,
	data?: Record<string, string | number | boolean | null | undefined>,
): Diagnostic => makeDiag(code, "error", message, loc, data);

/** Stable de-duplication key: same code at the same place is the same problem. */
function diagKey(diag: Diagnostic): string {
	const loc = diag.loc
		? `${diag.loc.file}:${diag.loc.line}:${diag.loc.column ?? 0}`
		: "-";
	return `${diag.code}|${loc}|${diag.message}`;
}

export function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
	const seen = new Set<string>();
	const out: Diagnostic[] = [];
	for (const diag of diagnostics) {
		const key = diagKey(diag);
		if (!seen.has(key)) {
			seen.add(key);
			out.push(diag);
		}
	}
	return out;
}

/**
 * Thrown when a requested analysis target cannot be located. This is the only
 * user-facing throw in the engine; everything else degrades into `warnings`.
 */
export class AnalysisTargetError extends Error {
	readonly code: "class_not_found" | "ambiguous_class" | "file_not_found";
	readonly candidates?: string[];
	readonly suggestions?: string[];

	constructor(
		code: "class_not_found" | "ambiguous_class" | "file_not_found",
		message: string,
		extra?: { candidates?: string[]; suggestions?: string[] },
	) {
		super(message);
		this.name = "AnalysisTargetError";
		this.code = code;
		if (extra?.candidates) {
			this.candidates = extra.candidates;
		}
		if (extra?.suggestions) {
			this.suggestions = extra.suggestions;
		}
	}
}

/** Thrown when a workspace exceeds a hard guard (currently only `maxFiles`). */
export class AnalysisLimitError extends Error {
	readonly code: "max_files_exceeded";
	readonly limit: number;
	readonly actual: number;

	constructor(limit: number, actual: number) {
		// Names no option: the engine is consumed by the MCP server (whose flags are
		// `--src-dir` / `--max-files`), by tests calling `Workspace.acquire`, and by
		// anything embedding it later. A message that spells one surface's option
		// names is wrong advice everywhere else, and the MCP layer already attaches
		// its own flag-shaped hint.
		super(
			`Analysis scope contains ${actual} source files, more than the configured limit of ${limit}. ` +
				"Narrow the analysed directories, or raise the file limit.",
		);
		this.name = "AnalysisLimitError";
		this.code = "max_files_exceeded";
		this.limit = limit;
		this.actual = actual;
	}
}
