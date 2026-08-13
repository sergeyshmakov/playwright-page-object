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

/**
 * Serialized response size cap.
 *
 * 200 KB is roughly 50k tokens — deliberately larger than what a client will
 * accept whole, because the client is the right place to decide that. Claude
 * Code allows 25k tokens by default, raises a tool's own ceiling to the
 * `anthropic/maxResultSizeChars` annotation (see `LARGE_RESULT` in
 * server.ts) up to 500k, and spills anything past that to disk with a file
 * reference. The earlier 40 KB was stricter than every client we target and
 * was rejecting answers all of them would have taken: on a 4,924-file repo it
 * turned `map_coverage` into four failed calls.
 *
 * A cap still exists so a runaway payload fails with a hint rather than
 * flooding a context window.
 *
 * Measured in UTF-8 bytes, which is what goes over stdio — see
 * {@link responseBytes}. It used to be compared against `String.length`, and
 * those are the same number only for ASCII: 40,000 CJK characters are 40,000
 * code units and about 120,000 bytes, so a payload three times the cap passed
 * the check that exists to stop it.
 */
export const MAX_RESPONSE_BYTES = 200_000;

/**
 * What this payload actually costs on the wire.
 *
 * `String.length` counts UTF-16 code units. Every non-ASCII character in a test
 * id, a JSDoc summary, a selector or a source snippet makes it an undercount,
 * and this server's whole job on a real repository is to carry other people's
 * identifiers — which, on the app that drove most of this work, are Russian.
 */
export function responseBytes(serialized: string): number {
	return Buffer.byteLength(serialized, "utf8");
}

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
	/**
	 * Run when the response ships, and not when it is refused for being too
	 * large. The warning ledger records what the reader has been shown, and a
	 * payload that never left is not something they were shown — recording it
	 * would abbreviate, on the next call, warnings this one swallowed.
	 */
	onDelivered?: () => void;
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
	const bytes = responseBytes(serialized);
	if (bytes <= MAX_RESPONSE_BYTES) {
		options.onDelivered?.();
		return { content: [{ type: "text", text: serialized }] };
	}

	return fail(
		new ToolError(
			"too_large",
			`Response is ${bytes} bytes (cap ${MAX_RESPONSE_BYTES}).`,
			{ hint: options.shrinkHint ?? GENERIC_SHRINK_HINT },
		),
	);
}

/**
 * Bytes {@link ok} would put on the wire for this payload.
 *
 * The same serialization `ok` performs, so a caller sizing a response against
 * the cap and the cap itself cannot disagree about what counts — `compactMeta`
 * removing an empty array is worth a few hundred bytes on a coverage report.
 */
export function envelopeBytes(data: unknown, meta?: ToolMeta): number {
	const cleanedMeta = compactMeta(meta);
	const payload: Record<string, unknown> = { ok: true, data };
	if (cleanedMeta) {
		payload.meta = cleanedMeta;
	}
	return responseBytes(JSON.stringify(payload));
}

/** One list a response would like to ship, and the entries it holds. */
export interface BucketSlice {
	name: string;
	entries: unknown[];
}

/** How many entries of each slice fit, keyed by slice name. */
export type BucketFit = Map<string, number>;

/**
 * Spends a byte budget across several lists.
 *
 * The fit is measured, not estimated, but it is measured *once per entry*:
 * every entry is serialized a single time up front and the algorithm then works
 * on integers. Re-serializing the whole payload after each candidate entry
 * would be quadratic on the lists this exists for (a 981-entry bucket on a
 * 4,924-file repository), and estimating from an average entry size is wrong in
 * the direction that matters — one long `raw` expression and the response
 * overshoots the cap it was trying to respect.
 *
 * Two passes, because a single greedy walk in bucket order starves the last
 * bucket: an equal share each, then whatever nobody spent is offered to the
 * lists that were cut, in order. Every entry costs its serialized length plus
 * one byte for the comma that joins it.
 */
export function fitBuckets(budget: number, slices: BucketSlice[]): BucketFit {
	const fit: BucketFit = new Map();
	if (slices.length === 0) {
		return fit;
	}
	const sizes = slices.map((slice) =>
		// Bytes, like the budget they are spent against: an entry sized in code
		// units under-charges for every non-ASCII id it carries, and the fit then
		// overshoots the cap it was computed to respect.
		slice.entries.map((entry) => responseBytes(JSON.stringify(entry)) + 1),
	);
	const share = Math.floor(Math.max(budget, 0) / slices.length);
	const kept = slices.map(() => 0);
	// The rounding remainder joins the shared pot rather than being lost.
	let spare = Math.max(budget, 0) - share * slices.length;

	slices.forEach((_, index) => {
		let spent = 0;
		const own = sizes[index];
		while (kept[index] < own.length && spent + own[kept[index]] <= share) {
			spent += own[kept[index]];
			kept[index] += 1;
		}
		spare += share - spent;
	});

	slices.forEach((_, index) => {
		const own = sizes[index];
		while (kept[index] < own.length && own[kept[index]] <= spare) {
			spare -= own[kept[index]];
			kept[index] += 1;
		}
	});

	slices.forEach((slice, index) => {
		fit.set(slice.name, kept[index]);
	});
	return fit;
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

/** The SDK's own phrasing when a call fails its `inputSchema`. */
const SDK_VALIDATION_PREFIX = "Input validation error:";

/**
 * Puts schema-validation failures in the same envelope as everything else.
 *
 * The SDK validates `inputSchema` before a handler is ever called, so
 * {@link safeHandler} cannot see it, and what went out was a bare string:
 * `isError: true` with no `code`, no `hint`, and none of the JSON shape every
 * other failure has. A client parsing tool output had to handle two forms, and
 * only ever found out which by parsing.
 *
 * Feature-detected on purpose. `createToolError` is the SDK's method, not ours;
 * if an upgrade renames it this quietly leaves the old behaviour in place
 * rather than throwing at construction. `envelopesValidationErrors` reports
 * whether the hook took, and a test pins it so the upgrade that breaks it fails
 * loudly instead of silently regressing the shape.
 */
export function envelopeValidationErrors(server: unknown): boolean {
	const target = server as { createToolError?: (message: string) => unknown };
	if (typeof target.createToolError !== "function") {
		return false;
	}
	const original = target.createToolError.bind(target);
	target.createToolError = (message: string) => {
		if (!message.startsWith(SDK_VALIDATION_PREFIX)) {
			return original(message);
		}
		return fail(
			new ToolError(
				"invalid_input",
				message.slice(SDK_VALIDATION_PREFIX.length).trim(),
				{
					hint: "Check the argument against the tool's inputSchema in tools/list, then re-call.",
				},
			),
		);
	};
	return true;
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
