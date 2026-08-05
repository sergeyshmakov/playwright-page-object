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

/**
 * Last line of defense against stdout pollution from transitive deps: route
 * console.log/info/debug to the stderr logger. Call before connecting the
 * stdio transport.
 */
export function redirectConsoleToStderr(): void {
	console.log = (...args: unknown[]) =>
		logger.debug(args.map(String).join(" "));
	console.info = (...args: unknown[]) =>
		logger.debug(args.map(String).join(" "));
	console.debug = (...args: unknown[]) =>
		logger.debug(args.map(String).join(" "));
	console.warn = (...args: unknown[]) =>
		logger.error(args.map(String).join(" "));
}
