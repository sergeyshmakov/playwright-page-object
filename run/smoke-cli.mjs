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

		console.log("smoke-cli: all assertions passed");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error.message ?? error);
	process.exit(1);
});
