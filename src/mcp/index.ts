import {
	type StdioServerHandle,
	serveStdio,
} from "@modelcontextprotocol/server/stdio";
import type { LogLevel } from "./logger";
import { logger, pushLogLevel, redirectConsoleToStderr } from "./logger";
import type { McpServerOptions } from "./options";
import { createMcpServer } from "./server";

export type { McpServerOptions } from "./options";
export { validateServerOptions } from "./options";
export { createMcpServer } from "./server";

export interface RunMcpServerOptions extends McpServerOptions {
	logLevel?: LogLevel;
}

/**
 * Starts the MCP server over stdio. Used by the `playwright-page-object mcp`
 * CLI subcommand; exported so the server can also be mounted programmatically.
 */
export function runMcpServer(options: RunMcpServerOptions): StdioServerHandle {
	// Registered rather than assigned: the level is process-wide, so a second
	// server must not silence the first, and closing one must not leave its
	// level behind. See `pushLogLevel`.
	const releaseLevel = pushLogLevel(options.logLevel ?? "error");
	// Global, and the process may not be ours: this is exported, so a host
	// application mounting the server has its own logging taken over for as long
	// as the transport is up. Undone on close, or it stays taken over — and at
	// the default `error` level a redirected `console.log` is not moved to
	// stderr, it is dropped.
	const restoreConsole = redirectConsoleToStderr();

	const handle = serveStdio(() => createMcpServer(options), {
		onerror: (error) => logger.error(error.message),
	});

	logger.info(`serving MCP over stdio (root: ${options.projectRoot})`);
	return {
		...handle,
		close: async () => {
			try {
				await handle.close();
			} finally {
				// In `finally`: a transport that failed to shut down cleanly is
				// exactly when the caller most needs their own logging back.
				restoreConsole();
				releaseLevel();
			}
		},
	};
}
