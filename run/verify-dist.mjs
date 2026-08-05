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

// The library entry must stay free of the CLI/MCP dependency graph so
// decorator-only consumers never load it. dist/cli.js reaches the MCP
// module only through the external self-reference, so it must not inline
// the SDK or ts-morph either.
const forbidden = ["ts-morph", "@modelcontextprotocol", "zod"];
for (const artifact of ["dist/index.js", "dist/index.mjs", "dist/cli.js"]) {
	const source = contents.get(artifact);
	if (source === undefined) {
		continue;
	}
	for (const dependency of forbidden) {
		if (source.includes(dependency)) {
			errors.push(`${artifact} references "${dependency}"`);
		}
	}
}

if (errors.length > 0) {
	for (const error of errors) {
		console.error(`verify-dist: ${error}`);
	}
	process.exit(1);
}

console.log("verify-dist: dist artifacts look good");
