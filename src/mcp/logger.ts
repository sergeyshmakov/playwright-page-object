/**
 * stderr-only logger. stdout is the JSON-RPC frame channel for a stdio MCP
 * server — a single stray line on stdout corrupts the protocol stream.
 */

export type LogLevel = "silent" | "error" | "info" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = {
	silent: 0,
	error: 1,
	info: 2,
	debug: 3,
};

let currentLevel: LogLevel = "error";

export function setLogLevel(level: LogLevel): void {
	currentLevel = level;
}

function write(level: Exclude<LogLevel, "silent">, message: string): void {
	if (LEVEL_ORDER[currentLevel] < LEVEL_ORDER[level]) {
		return;
	}
	process.stderr.write(`[playwright-page-object] ${message}\n`);
}

export const logger = {
	error: (message: string) => write("error", message),
	info: (message: string) => write("info", message),
	debug: (message: string) => write("debug", message),
};

/** The four methods {@link redirectConsoleToStderr} takes over. */
const REDIRECTED = ["log", "info", "debug", "warn"] as const;

/**
 * Last line of defense against stdout pollution from transitive deps: route
 * console.log/info/debug to the stderr logger. Call before connecting the
 * stdio transport.
 *
 * Returns a function that puts the originals back. That matters because this
 * is a global mutation of a process the caller may not own: through the
 * exported `runMcpServer`, a host application's own logging is taken over for
 * as long as the server runs, and without a way back it stayed taken over
 * afterwards — at the default `error` level, silently dropped.
 *
 * Idempotent in both directions. Redirecting twice does not capture the
 * already-redirected functions as the originals, and restoring twice, or after
 * something else has replaced a method, leaves the current one alone rather
 * than reinstating a stale closure over a dead transport.
 */
export function redirectConsoleToStderr(): () => void {
	const originals = new Map(
		REDIRECTED.map((name) => [name, console[name]] as const),
	);
	const installed = new Map<string, unknown>();
	const to =
		(level: "debug" | "error") =>
		(...args: unknown[]) =>
			logger[level](args.map(String).join(" "));

	for (const name of REDIRECTED) {
		const replacement = to(name === "warn" ? "error" : "debug");
		console[name] = replacement;
		installed.set(name, replacement);
	}

	return () => {
		for (const name of REDIRECTED) {
			// Only if ours is still the one in place. A caller that installed its
			// own logging after us owns the method now, and handing it back a
			// function captured before that would be the same bug in reverse.
			if (console[name] === installed.get(name)) {
				const original = originals.get(name);
				if (original) {
					console[name] = original;
				}
			}
		}
	};
}
