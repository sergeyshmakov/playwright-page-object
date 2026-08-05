import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CLI entry point (`playwright-page-object` bin). Built as CJS only; the
 * shebang is prepended by tsup at build time.
 *
 * The version is read at runtime: semantic-release bumps package.json AFTER
 * the build step, so inlining it at build time would ship a stale version.
 */

const HELP = `playwright-page-object - typed, decorator-driven Page Object Model for Playwright

Usage:
  playwright-page-object [options]

Options:
  -v, --version   Print the installed version
  -h, --help      Show this help

Documentation: https://pom.shmakov.tools
`;

function readVersion(): string {
	const packageJson = JSON.parse(
		readFileSync(join(__dirname, "..", "package.json"), "utf8"),
	) as { version: string };
	return packageJson.version;
}

function main(argv: string[]): number {
	const [first] = argv;

	if (first === undefined || first === "--help" || first === "-h") {
		process.stdout.write(HELP);
		return 0;
	}

	if (first === "--version" || first === "-v") {
		process.stdout.write(`${readVersion()}\n`);
		return 0;
	}

	process.stderr.write(
		`Unknown command: ${first}\nRun "playwright-page-object --help" for usage.\n`,
	);
	return 1;
}

process.exitCode = main(process.argv.slice(2));
