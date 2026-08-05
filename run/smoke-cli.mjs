import { spawn } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Smoke test for the published-package surface. Installs the packed tarball
 * into a temp project (exactly what `npx playwright-page-object` would
 * materialize) and asserts:
 *
 * - the bin resolves and reports the manifest version (catches stale dist,
 *   wrong bin target, broken shebang / Windows shim)
 * - --help exits 0, unknown commands exit 1 via stderr
 * - the package resolves from BOTH require() and import() (exports map)
 * - cross-copy identity holds when the CJS and ESM builds are loaded in one
 *   process (the dual-package hazard the Symbol.for hardening exists for)
 */

const rootDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const tarballPath = path.join(rootDir, "playwright-page-object.tgz");

function spawnCommand(command, args, options) {
	if (process.platform === "win32") {
		return spawn(
			process.env.ComSpec || "cmd.exe",
			["/d", "/s", "/c", `${command} ${args.join(" ")}`],
			options,
		);
	}

	return spawn(command, args, options);
}

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawnCommand(command, args, {
			cwd: options.cwd ?? rootDir,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		child.on("error", reject);
		child.on("exit", (code) => {
			resolve({ code, stdout, stderr });
		});
	});
}

function assert(condition, message) {
	if (!condition) {
		throw new Error(`smoke-cli: ${message}`);
	}
}

/**
 * Spawns `<bin> mcp` and drives a real JSON-RPC session over stdio:
 * initialize -> tools/list. Proves the runtime deps installed from the
 * tarball, the CJS require of the SDK resolves, and - critically - that
 * stdout carries nothing but parseable JSON-RPC frames.
 */
function smokeMcpHandshake(tempDir) {
	return new Promise((resolvePromise, rejectPromise) => {
		// Spawn node directly (not the .cmd shim): kill() must reach the actual
		// server process, or its cwd keeps the temp dir locked on Windows. The
		// shim itself is already exercised by the --version/--help checks.
		const cliPath = path.join(
			tempDir,
			"node_modules",
			"playwright-page-object",
			"dist",
			"cli.js",
		);
		const child = spawn(process.execPath, [cliPath, "mcp"], {
			cwd: tempDir,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const timeout = setTimeout(() => {
			child.kill();
			rejectPromise(new Error("smoke-cli: MCP handshake timed out (30s)"));
		}, 30_000);

		let buffer = "";
		let stderr = "";
		const responses = [];
		let settled = false;

		const finish = (error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			// Wait for the child to actually exit so it releases its cwd —
			// otherwise the temp-dir cleanup hits EPERM on Windows.
			const settle = () => {
				if (error) {
					rejectPromise(error);
				} else {
					resolvePromise();
				}
			};
			if (child.exitCode !== null) {
				settle();
				return;
			}
			const exitGuard = setTimeout(settle, 3_000);
			child.once("exit", () => {
				clearTimeout(exitGuard);
				settle();
			});
			child.kill();
		};

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				newlineIndex = buffer.indexOf("\n");
				if (line.length === 0) {
					continue;
				}
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					finish(
						new Error(
							`smoke-cli: MCP stdout emitted a non-JSON line: ${line.slice(0, 200)}`,
						),
					);
					return;
				}
				responses.push(message);

				if (message.id === 1) {
					if (!message.result?.serverInfo) {
						finish(
							new Error(
								`smoke-cli: initialize response lacks serverInfo: ${line.slice(0, 200)}`,
							),
						);
						return;
					}
					child.stdin.write(
						`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
					);
					child.stdin.write(
						`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
					);
				}

				if (message.id === 2) {
					const tools = message.result?.tools;
					if (!Array.isArray(tools) || tools.length !== 4) {
						finish(
							new Error(
								`smoke-cli: tools/list returned ${Array.isArray(tools) ? tools.length : "no"} tools, expected 4`,
							),
						);
						return;
					}
					finish();
					return;
				}
			}
		});

		child.on("error", (error) => finish(error));
		child.on("exit", (code) => {
			if (!settled) {
				finish(
					new Error(
						`smoke-cli: MCP server exited early (code ${code}):\n${stderr}`,
					),
				);
			}
		});

		child.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "smoke-cli", version: "0.0.0" },
				},
			})}\n`,
		);
	});
}

async function main() {
	if (!existsSync(tarballPath)) {
		console.log("smoke-cli: tarball missing, running pack:example first");
		const pack = await run("npm", ["run", "pack:example"]);
		assert(pack.code === 0, `pack:example failed:\n${pack.stderr}`);
	}

	const { version } = JSON.parse(
		readFileSync(path.join(rootDir, "package.json"), "utf8"),
	);

	const tempDir = mkdtempSync(path.join(tmpdir(), "ppo-smoke-"));

	try {
		writeFileSync(
			path.join(tempDir, "package.json"),
			JSON.stringify({ name: "ppo-smoke", private: true }),
		);

		// Copy the tarball next to the temp manifest so the install argument is
		// a bare relative name - no cross-platform path quoting to get wrong.
		copyFileSync(tarballPath, path.join(tempDir, "playwright-page-object.tgz"));

		const install = await run(
			"npm",
			["install", "--no-audit", "--no-fund", "./playwright-page-object.tgz"],
			{ cwd: tempDir },
		);
		assert(install.code === 0, `npm install failed:\n${install.stderr}`);

		const binPath = path.join("node_modules", ".bin", "playwright-page-object");

		const versionResult = await run(binPath, ["--version"], { cwd: tempDir });
		assert(
			versionResult.code === 0,
			`--version exited ${versionResult.code}:\n${versionResult.stderr}`,
		);
		assert(
			versionResult.stdout.trim() === version,
			`--version printed "${versionResult.stdout.trim()}", expected "${version}"`,
		);

		const helpResult = await run(binPath, ["--help"], { cwd: tempDir });
		assert(helpResult.code === 0, `--help exited ${helpResult.code}`);
		assert(helpResult.stdout.includes("Usage"), "--help output lacks Usage");

		const unknownResult = await run(binPath, ["definitely-not-a-command"], {
			cwd: tempDir,
		});
		assert(
			unknownResult.code === 1,
			`unknown command exited ${unknownResult.code}, expected 1`,
		);
		assert(
			unknownResult.stderr.includes("Unknown command"),
			"unknown command did not write to stderr",
		);

		writeFileSync(
			path.join(tempDir, "check-require.cjs"),
			`const { PageObject } = require("playwright-page-object");
if (typeof PageObject !== "function") process.exit(1);
`,
		);
		const requireResult = await run("node", ["check-require.cjs"], {
			cwd: tempDir,
		});
		assert(
			requireResult.code === 0,
			`require() resolution failed:\n${requireResult.stderr}`,
		);

		writeFileSync(
			path.join(tempDir, "check-import.mjs"),
			`import { PageObject } from "playwright-page-object";
if (typeof PageObject !== "function") process.exit(1);
`,
		);
		const importResult = await run("node", ["check-import.mjs"], {
			cwd: tempDir,
		});
		assert(
			importResult.code === 0,
			`import resolution failed:\n${importResult.stderr}`,
		);

		writeFileSync(
			path.join(tempDir, "check-dual.mjs"),
			`import { createRequire } from "node:module";
import { PageObject as EsmPageObject, RootPageObject as EsmRootPageObject } from "playwright-page-object";

const require = createRequire(import.meta.url);
const cjs = require("playwright-page-object");

// The exports map hands ESM and CJS different files, so these are two module
// instances. The Symbol.for brands must keep them interoperable.
if (!cjs.PageObject.isInstance(new EsmPageObject())) {
	console.error("cross-copy isInstance failed");
	process.exit(1);
}
class EsmControl extends EsmPageObject {}
if (!cjs.PageObject.isClass(EsmControl)) {
	console.error("cross-copy isClass failed");
	process.exit(1);
}
class EsmRoot extends EsmRootPageObject {}
if (!cjs.RootPageObject.isRootClass(EsmRoot)) {
	console.error("cross-copy isRootClass failed");
	process.exit(1);
}
if (cjs.RootPageObject.isRootClass(EsmRootPageObject)) {
	console.error("cross-copy isRootClass matched the base class itself");
	process.exit(1);
}
`,
		);
		const dualResult = await run("node", ["check-dual.mjs"], { cwd: tempDir });
		assert(
			dualResult.code === 0,
			`dual-package identity check failed:\n${dualResult.stderr}`,
		);

		await smokeMcpHandshake(tempDir);

		console.log("smoke-cli: all assertions passed");
	} finally {
		try {
			rmSync(tempDir, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 100,
			});
		} catch (cleanupError) {
			console.warn(
				`smoke-cli: temp dir cleanup failed (non-fatal): ${cleanupError.message}`,
			);
		}
	}
}

main().catch((error) => {
	console.error(error.message ?? error);
	process.exit(1);
});
