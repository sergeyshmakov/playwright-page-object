import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Publish-time guard (wired as `prepublishOnly`). Verifies the built `dist/`
 * instead of rebuilding: semantic-release runs this inside its publish phase,
 * after the changelog/version commit — a rebuild failure there would leave a
 * half-finished release behind.
 */

const rootDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

const errors = [];

const artifacts = [
	"dist/index.js",
	"dist/index.mjs",
	"dist/index.d.ts",
	"dist/index.d.mts",
	"dist/cli.js",
	"dist/mcp.js",
	"dist/mcp.mjs",
	"dist/mcp.d.ts",
	"dist/mcp.d.mts",
];

const contents = new Map();

for (const artifact of artifacts) {
	try {
		contents.set(artifact, readFileSync(path.join(rootDir, artifact), "utf8"));
	} catch {
		errors.push(`Missing build artifact: ${artifact}`);
	}
}

const cli = contents.get("dist/cli.js");
if (cli !== undefined && !cli.startsWith("#!")) {
	errors.push(
		"dist/cli.js does not start with a shebang - npx and Windows bin shims will break",
	);
}

// Everything the analysis engine drags in. The library entry must stay free of
// it so decorator-only consumers never load it, and dist/cli.js reaches the MCP
// module only through the external self-reference, so it must not name any of
// this either - not the SDK, not ts-morph, and not the glob and exports-map
// readers the engine resolves paths with.
const analysisGraph = [
	"ts-morph",
	"@modelcontextprotocol",
	"zod",
	"picomatch",
	"resolve.exports",
];

// `commander` is the CLI's own argument parser, required directly by
// dist/cli.js - which is what its entry in `dependencies` is for. It has no
// business in the library entry.
const forbidden = new Map([
	["dist/index.js", [...analysisGraph, "commander"]],
	["dist/index.mjs", [...analysisGraph, "commander"]],
	["dist/cli.js", analysisGraph],
]);

for (const [artifact, dependencies] of forbidden) {
	const source = contents.get(artifact);
	if (source === undefined) {
		continue;
	}
	for (const dependency of dependencies) {
		if (source.includes(dependency)) {
			errors.push(`${artifact} references "${dependency}"`);
		}
	}
}

// And commander must stay an external require rather than being bundled in:
// `--version` and `--help` are meant to answer without loading a parser copy,
// and an inlined one would also silently pin a second version of it.
if (cli !== undefined && !/require\(["']commander["']\)/.test(cli)) {
	errors.push(
		'dist/cli.js does not require "commander" externally - the parser was inlined',
	);
}

// Both conditions of `playwright-page-object/mcp` must advertise the real
// version. `readVersion` reads `__dirname`, which does not exist in an ESM
// module: the reference threw, its `try` swallowed the error, and the ESM
// entry reported 0.0.0 in the MCP handshake while the CJS entry reported the
// real number. Nothing in the source distinguishes the two, so the only place
// this is visible is here, by booting each and asking.
const expectedVersion = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
for (const [label, specifier] of [
	["dist/mcp.js", "../dist/mcp.js"],
	["dist/mcp.mjs", "../dist/mcp.mjs"],
]) {
	try {
		const { createMcpServer } = await import(
			new URL(specifier, import.meta.url).href
		);
		const server = createMcpServer({
			projectRoot: new URL("..", import.meta.url).pathname,
		});
		const reported = (server?.server?._serverInfo ?? server?._serverInfo)
			?.version;
		if (reported !== expectedVersion) {
			errors.push(
				`${label} advertises version "${reported}" - expected "${expectedVersion}"`,
			);
		}
	} catch (error) {
		errors.push(`${label} could not be booted: ${error.message}`);
	}
}

if (errors.length > 0) {
	for (const error of errors) {
		console.error(`verify-dist: ${error}`);
	}
	process.exit(1);
}

console.log("verify-dist: dist artifacts look good");
