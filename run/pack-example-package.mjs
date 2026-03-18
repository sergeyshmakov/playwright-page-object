import { spawn } from "node:child_process";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const npmCommand = "npm";
const stableTarballName = "playwright-page-object.tgz";

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

function run(command, args, cwd = rootDir) {
	return new Promise((resolve, reject) => {
		const child = spawnCommand(command, args, {
			cwd,
			stdio: "inherit",
		});

		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) {
				resolve();
				return;
			}

			reject(
				new Error(
					`Command failed with exit code ${code}: ${command} ${args.join(" ")}`,
				),
			);
		});
	});
}

function capture(command, args, cwd = rootDir) {
	return new Promise((resolve, reject) => {
		const child = spawnCommand(command, args, {
			cwd,
			stdio: ["ignore", "pipe", "inherit"],
		});

		let stdout = "";

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});

		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) {
				resolve(stdout);
				return;
			}

			reject(
				new Error(
					`Command failed with exit code ${code}: ${command} ${args.join(" ")}`,
				),
			);
		});
	});
}

async function main() {
	await run(npmCommand, ["run", "build"]);

	const packOutput = await capture(npmCommand, [
		"pack",
		"--pack-destination",
		".",
		"--json",
	]);
	const [packResult] = JSON.parse(packOutput);

	if (!packResult?.filename) {
		throw new Error("npm pack did not return a tarball filename");
	}

	const versionedTarballPath = path.join(rootDir, packResult.filename);
	const stableTarballPath = path.join(rootDir, stableTarballName);

	await rm(stableTarballPath, { force: true });
	await rename(versionedTarballPath, stableTarballPath);

	console.log(`Packed ${stableTarballName}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
