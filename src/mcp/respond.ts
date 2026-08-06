import { AnalysisLimitError, AnalysisTargetError } from "../analysis";
import { ToolError, type ToolErrorCode } from "./errors";
import { logger } from "./logger";

/**
 * Response envelope helpers. Every tool returns a single compact-JSON text
 * block: `{"ok":true,"data":...,"meta":{...}}` on success,
 * `{"ok":false,"error":{...}}` with `isError: true` on failure.
 *
 * Compact (unindented) JSON is deliberate — indentation costs 20-35% extra
 * tokens on deep trees and buys the consuming model nothing.
 */

/** Serialized response size cap (~10k tokens) before truncation kicks in. */
export const MAX_RESPONSE_BYTES = 40_000;

export interface ToolMeta {
	[key: string]: unknown;
}

export interface TextResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	[key: string]: unknown;
}

function textResult(payload: unknown, isError = false): TextResult {
	const result: TextResult = {
		content: [{ type: "text", text: JSON.stringify(payload) }],
	};
	if (isError) {
		result.isError = true;
	}
	return result;
}

function compactMeta(meta: ToolMeta | undefined): ToolMeta | undefined {
	if (!meta) {
		return undefined;
	}
	const entries = Object.entries(meta).filter(([, value]) => {
		if (value === undefined || value === null || value === false) {
			return false;
		}
		if (Array.isArray(value) && value.length === 0) {
			return false;
		}
		return true;
	});
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export interface OkOptions {
	/**
	 * What to change to make *this* tool's response smaller, in its own argument
	 * names. The generic advice named knobs three of the four tools do not have
	 * ("a smaller depth" to `list_page_objects`), so the one caller who most
	 * needs a next move got advice that does not typecheck.
	 */
	shrinkHint?: string;
}

const GENERIC_SHRINK_HINT =
	"Re-call with a smaller depth, a narrower filter, or address a single class or file.";

export function ok(
	data: unknown,
	meta?: ToolMeta,
	options: OkOptions = {},
): TextResult {
	const cleanedMeta = compactMeta(meta);
	const payload: Record<string, unknown> = { ok: true, data };
	if (cleanedMeta) {
		payload.meta = cleanedMeta;
	}

	const serialized = JSON.stringify(payload);
	if (serialized.length <= MAX_RESPONSE_BYTES) {
		return { content: [{ type: "text", text: serialized }] };
	}

	return fail(
		new ToolError(
			"too_large",
			`Response is ${serialized.length} bytes (cap ${MAX_RESPONSE_BYTES}).`,
			{ hint: options.shrinkHint ?? GENERIC_SHRINK_HINT },
		),
	);
}

/** A list of things to pick from stops being one somewhere around a dozen. */
export const MAX_ERROR_LIST = 10;

export function fail(error: ToolError): TextResult {
	const body: Record<string, unknown> = {
		code: error.code,
		message: error.message,
	};
	if (error.candidates && error.candidates.length > 0) {
		body.candidates = error.candidates.slice(0, MAX_ERROR_LIST);
		if (error.candidates.length > MAX_ERROR_LIST) {
			body.moreCandidates = error.candidates.length - MAX_ERROR_LIST;
		}
	}
	if (error.suggestions && error.suggestions.length > 0) {
		body.suggestions = error.suggestions.slice(0, MAX_ERROR_LIST);
		if (error.suggestions.length > MAX_ERROR_LIST) {
			body.moreSuggestions = error.suggestions.length - MAX_ERROR_LIST;
		}
	}
	if (error.hint) {
		body.hint = error.hint;
	}
	return textResult({ ok: false, error: body }, true);
}

function toToolError(thrown: unknown): ToolError {
	if (thrown instanceof ToolError) {
		return thrown;
	}
	if (thrown instanceof AnalysisTargetError) {
		return new ToolError(thrown.code as ToolErrorCode, thrown.message, {
			candidates: thrown.candidates,
			suggestions: thrown.suggestions,
			hint:
				thrown.code === "ambiguous_class"
					? "Re-call with `file` set to one of the candidates."
					: "Call list_page_objects to see every page object and its file.",
		});
	}
	if (thrown instanceof AnalysisLimitError) {
		return new ToolError("max_files_exceeded", thrown.message, {
			hint: "Restart the server with a higher --max-files, or narrow the scan with --src-dir / --tsconfig.",
		});
	}
	const message = thrown instanceof Error ? thrown.message : String(thrown);
	return new ToolError("internal_error", message);
}

/**
 * Wraps a tool handler so any thrown value becomes an in-band tool error.
 * An unexpected ts-morph crash must never surface as a JSON-RPC transport
 * error — agents cannot recover from those.
 */
export function safeHandler<TArgs>(
	handler: (args: TArgs) => Promise<TextResult> | TextResult,
): (args: TArgs) => Promise<TextResult> {
	return async (args: TArgs) => {
		try {
			return await handler(args);
		} catch (thrown) {
			const error = toToolError(thrown);
			if (error.code === "internal_error") {
				logger.error(`internal error: ${error.message}`);
			}
			return fail(error);
		}
	};
}
