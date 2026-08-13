import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Launcher for the project-scoped MCP server in `.mcp.json`.
 *
 * `dist/` is gitignored and `npm ci` runs only `prepare` (husky), so on a fresh
 * checkout `dist/cli.js` does not exist. An MCP client loads `.mcp.json` as
 * soon as the repository is opened, which meant the server died on
 * `MODULE_NOT_FOUND` before anyone had run a build — and the first thing a new
 * contributor saw of this package's own tooling was a broken server.
 *
 * So: build if, and only if, the entry is missing. The common path is a
 * `spawn` with one `existsSync` in front of it, not a build per editor start.
 * A stale `dist/` is deliberately *not* rebuilt here — `npm run dev` owns that,
 * and rebuilding on every launch would trade a rare failure for a constant
 * cost.
 *
 * Nothing may reach stdout but the server: it speaks JSON-RPC over it, and a
 * line of build output is a protocol error. The build's stdout is pointed at
 * stderr for that reason.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");

if (!existsSync(cli)) {
	process.stderr.write("[mcp] dist/cli.js is missing; building once…\n");
	const built = spawnSync("npm", ["run", "build"], {
		cwd: repoRoot,
		shell: process.platform === "win32",
		// stdout -> stderr: see above.
		stdio: ["ignore", 2, 2],
	});
	if (built.status !== 0) {
		process.stderr.write("[mcp] build failed; run `npm run build` by hand.\n");
		process.exit(built.status ?? 1);
	}
}

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
	cwd: repoRoot,
	stdio: "inherit",
});
child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 0);
});
