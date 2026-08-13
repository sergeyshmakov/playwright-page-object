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

/**
 * Stopping the launcher has to stop the server.
 *
 * A host that signals this process by pid rather than killing the group would
 * otherwise leave the CLI reparented and running, holding the inherited stdio
 * and a parsed workspace — measured at hundreds of megabytes on a large
 * repository — after the client believes the server is gone. Nothing would ever
 * reap it.
 *
 * The parent does not exit here: `child.on("exit")` below is what ends it, so
 * the server gets to shut down and the launcher reports its real status.
 */
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"];
for (const signal of FORWARDED) {
	process.on(signal, () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill(signal);
		}
	});
}

child.on("exit", (code, signal) => {
	if (signal) {
		// Die the way the child died. The handlers above have to go first: with
		// them installed, re-raising would call one of them instead of ending
		// this process, and it would hang holding the pipe it was asked to
		// release.
		for (const name of FORWARDED) {
			process.removeAllListeners(name);
		}
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 0);
});
