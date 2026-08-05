import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

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

const HELP = `playwright-page-object - typed, decorator-driven Page Object Model for Playwright

Usage:
  playwright-page-object <command> [options]

Commands:
  mcp   Start the MCP server (stdio) exposing static analysis of the page
        objects and rendered test ids in this repository.

Options for mcp:
  --project-root <dir>   Repository root to analyze          (default: cwd)
  --tsconfig <file>      tsconfig.json to use                (default: discovered)
  --src-dir <dir>        Restrict scanning to this directory (repeatable)
  --attribute <name>     Test-id attribute                   (default: playwright.config use.testIdAttribute, else data-testid)
  --max-files <n>        Cap on files parsed                 (default: 2000)
  --log-level <level>    silent | error | info | debug      (default: error, stderr only)

Global options:
  -v, --version   Print the installed version
  -h, --help      Show this help

Examples:
  npx playwright-page-object mcp
  npx playwright-page-object mcp --project-root apps/web --attribute data-qa

Documentation: https://pom.shmakov.tools/
`;

function readVersion(): string {
	const packageJson = JSON.parse(
		readFileSync(join(__dirname, "..", "package.json"), "utf8"),
	) as { version: string };
	return packageJson.version;
}

function fail(message: string): number {
	process.stderr.write(
		`${message}\nRun "playwright-page-object --help" for usage.\n`,
	);
	return 1;
}

function runMcp(argv: string[]): number {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			args: argv,
			options: {
				"project-root": { type: "string" },
				tsconfig: { type: "string" },
				"src-dir": { type: "string", multiple: true },
				attribute: { type: "string" },
				"max-files": { type: "string" },
				"log-level": { type: "string" },
			},
			strict: true,
			allowPositionals: false,
		});
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}

	const values = parsed.values as Record<string, string | string[] | undefined>;

	const logLevel = (values["log-level"] as string | undefined) ?? "error";
	if (!["silent", "error", "info", "debug"].includes(logLevel)) {
		return fail(`Invalid --log-level: ${logLevel}`);
	}

	let maxFiles: number | undefined;
	if (values["max-files"] !== undefined) {
		maxFiles = Number(values["max-files"]);
		if (!Number.isInteger(maxFiles) || maxFiles <= 0) {
			return fail(`Invalid --max-files: ${values["max-files"]}`);
		}
	}

	// Self-reference resolves through the package exports map to dist/mcp.js;
	// tsup keeps it external so the CLI bundle stays free of ts-morph/the SDK.
	const mcp = require("playwright-page-object/mcp") as typeof import("./mcp");

	const handle = mcp.runMcpServer({
		projectRoot: resolve((values["project-root"] as string | undefined) ?? ""),
		tsconfig: values.tsconfig as string | undefined,
		srcDirs: values["src-dir"] as string[] | undefined,
		attribute: values.attribute as string | undefined,
		maxFiles,
		logLevel: logLevel as "silent" | "error" | "info" | "debug",
	});

	const shutdown = () => {
		void handle.close().finally(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// Clients stop stdio servers by closing stdin.
	process.stdin.on("end", shutdown);
	process.stdin.on("close", shutdown);

	return 0;
}

function main(argv: string[]): number {
	const [first, ...rest] = argv;

	if (first === undefined || first === "--help" || first === "-h") {
		process.stdout.write(HELP);
		return 0;
	}

	if (first === "--version" || first === "-v") {
		process.stdout.write(`${readVersion()}\n`);
		return 0;
	}

	if (first === "mcp") {
		return runMcp(rest);
	}

	return fail(`Unknown command: ${first}`);
}

process.exitCode = main(process.argv.slice(2));
