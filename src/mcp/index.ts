import {
	type StdioServerHandle,
	serveStdio,
} from "@modelcontextprotocol/server/stdio";
import type { LogLevel } from "./logger";
import { logger, redirectConsoleToStderr, setLogLevel } from "./logger";
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
	setLogLevel(options.logLevel ?? "error");
	redirectConsoleToStderr();

	const handle = serveStdio(() => createMcpServer(options), {
		onerror: (error) => logger.error(error.message),
	});

	logger.info(`serving MCP over stdio (root: ${options.projectRoot})`);
	return handle;
}
