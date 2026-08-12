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
 * The functions this module installs, built once.
 *
 * Shared rather than per-activation so that two overlapping redirects install
 * the *same* function objects. That is what makes "is ours still in place?"
 * answerable at restore time without knowing which activation put it there.
 */
const REPLACEMENTS: Record<
	(typeof REDIRECTED)[number],
	(...a: unknown[]) => void
> = {
	log: (...args) => logger.debug(args.map(String).join(" ")),
	info: (...args) => logger.debug(args.map(String).join(" ")),
	debug: (...args) => logger.debug(args.map(String).join(" ")),
	warn: (...args) => logger.error(args.map(String).join(" ")),
};

/** The host's own methods, captured when the first redirect goes up. */
let pristineConsole: Map<string, (...a: never[]) => void> | null = null;
/** How many redirects are currently up. The last one out restores. */
let activeRedirects = 0;

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
 * Reference-counted, because two servers can be up at once and they do not
 * have to close in the order they opened. Capturing "the originals" per
 * activation looks right and is not: the second capture takes the *first*
 * redirect as its original, so closing first-then-second reinstates a redirect
 * instead of the host's console. Only the last one out restores, and what it
 * restores is what the console was before any of them started.
 *
 * Idempotent at both ends. Calling the returned function twice does nothing the
 * second time, and a method some other code replaced while the redirect was up
 * is left alone rather than overwritten with a stale closure over a dead
 * transport.
 */
export function redirectConsoleToStderr(): () => void {
	if (activeRedirects === 0) {
		pristineConsole = new Map(
			REDIRECTED.map((name) => [name, console[name]] as const),
		);
		for (const name of REDIRECTED) {
			console[name] = REPLACEMENTS[name];
		}
	}
	activeRedirects += 1;

	let released = false;
	return () => {
		if (released) {
			return;
		}
		released = true;
		activeRedirects -= 1;
		if (activeRedirects > 0 || pristineConsole === null) {
			// Another server is still serving and still needs stdout kept clean.
			return;
		}
		for (const name of REDIRECTED) {
			// Only if ours is still the one in place. A caller that installed its
			// own logging after us owns the method now, and handing it back a
			// function captured before that would be the same bug in reverse.
			if (console[name] === REPLACEMENTS[name]) {
				const original = pristineConsole.get(name);
				if (original) {
					console[name] = original as typeof console.log;
				}
			}
		}
		pristineConsole = null;
	};
}
