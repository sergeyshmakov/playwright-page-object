import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";

/**
 * CLI entry point (`playwright-page-object` bin). Built as CJS only; the
 * shebang is prepended by tsup at build time.
 *
 * The version is read at runtime: semantic-release bumps package.json AFTER
 * the build step, so inlining it at build time would ship a stale version.
 *
 * `--version`/`--help` must stay fast: the MCP module (and its ts-morph
 * dependency graph) loads only when the `mcp` subcommand is dispatched, via a
 * package self-reference that tsup leaves external.
 */

function readVersion(): string {
	const packageJson = JSON.parse(
		readFileSync(join(__dirname, "..", "package.json"), "utf8"),
	) as { version: string };
	return packageJson.version;
}

function parsePositiveInt(value: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new InvalidArgumentError("Expected a positive integer.");
	}
	return parsed;
}

function collect(value: string, previous: string[] = []): string[] {
	return previous.concat([value]);
}

interface McpCliOptions {
	projectRoot: string;
	tsconfig?: string;
	playwrightConfig?: string;
	srcDir?: string[];
	attribute?: string;
	maxFiles?: number;
	assumeForwarded?: boolean;
	logLevel: "silent" | "error" | "info" | "debug";
}

function runMcp(options: McpCliOptions): void {
	// Self-reference resolves through the package exports map to dist/mcp.js;
	// tsup keeps it external so the CLI bundle stays free of ts-morph/the SDK.
	const mcp = require("playwright-page-object/mcp") as typeof import("./mcp");

	const serverOptions = {
		projectRoot: resolve(options.projectRoot),
		tsconfig: options.tsconfig,
		playwrightConfig: options.playwrightConfig,
		srcDirs: options.srcDir,
		attribute: options.attribute,
		maxFiles: options.maxFiles,
		assumeForwarded: options.assumeForwarded === true,
	};

	// A stdio server that starts against a mistyped path stays up for the whole
	// session serving answers derived from a scope nobody asked for. Refusing at
	// startup is the only place a human still sees the message.
	const problems = mcp.validateServerOptions(serverOptions);
	if (problems.length > 0) {
		process.stderr.write(`${problems.join("\n")}\n`);
		process.exitCode = 1;
		return;
	}

	const handle = mcp.runMcpServer({
		...serverOptions,
		logLevel: options.logLevel,
	});

	const shutdown = () => {
		void handle.close().finally(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// Clients stop stdio servers by closing stdin.
	process.stdin.on("end", shutdown);
	process.stdin.on("close", shutdown);
}

const program = new Command();

program
	.name("playwright-page-object")
	.description(
		"Typed, decorator-driven Page Object Model for Playwright.\nDocumentation: https://pom.shmakov.tools/",
	)
	.version(readVersion(), "-v, --version", "Print the installed version")
	.helpCommand(false);

program
	.command("mcp")
	.description(
		"Start the MCP server (stdio) exposing static analysis of the page objects and rendered test ids in this repository.",
	)
	.option("--project-root <dir>", "Repository root to analyze", process.cwd())
	.option("--tsconfig <file>", "tsconfig.json to use (default: discovered)")
	.option(
		"--playwright-config <file>",
		"playwright.config.* to read (default: discovered, ranked)",
	)
	.option(
		"--src-dir <dir>",
		"Restrict scanning to this directory (repeatable)",
		collect,
	)
	.option(
		"--attribute <name>",
		"Test-id attribute (default: playwright.config use.testIdAttribute, else data-testid)",
	)
	.option(
		"--max-files <n>",
		"Cap on files parsed (default: 8000)",
		parsePositiveInt,
	)
	.option(
		"--assume-forwarded",
		"Count a test id written on a component tag as rendered. Off by default: a prop only reaches the DOM if the component forwards it. map_coverage labels every id and match the assumption changes.",
	)
	.addOption(
		new Option("--log-level <level>", "stderr verbosity")
			.choices(["silent", "error", "info", "debug"])
			.default("error"),
	)
	.addHelpText(
		"after",
		`
Examples:
  npx playwright-page-object mcp
  npx playwright-page-object mcp --project-root apps/web --attribute data-qa`,
	)
	.action((options: McpCliOptions) => {
		runMcp(options);
	});

// Bare invocation prints help and succeeds - it is a discovery gesture, not
// a mistake (commander's default for a missing subcommand is a silent no-op).
if (process.argv.length <= 2) {
	program.outputHelp();
} else {
	program.parse();
}
