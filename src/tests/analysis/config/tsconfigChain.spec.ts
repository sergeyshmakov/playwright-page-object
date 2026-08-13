import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { tsConfigChain } from "../../../analysis/config/tsconfig";
import { cleanupScratchRoots, scratchRepo } from "../helpers/onDisk";

function scratch(files: Record<string, string>): string {
	return scratchRepo(files, { prefix: "ppo-tschain-" });
}

afterAll(() => {
	cleanupScratchRoots();
});

/**
 * The list of configs whose contents decide the located one's options. It is
 * the freshness fingerprint: anything missing from it is a file the server
 * keeps using stale options from, while promising every caller that "results
 * reflect the files on disk at the moment of the call".
 */
describe("tsConfigChain", () => {
	/** Basenames in the chain, so assertions do not care about the temp root. */
	function names(root: string): string[] {
		return tsConfigChain(path.join(root, "tsconfig.json")).map((one) =>
			path.relative(root, one).split(path.sep).join("/"),
		);
	}

	it("follows a deep extensionless chain to the end", () => {
		// Each extensionless hop has two legal spellings and both are watched, so
		// counting *enqueued paths* against the hop budget spent it twice per hop
		// and cut the chain at the halfway mark. The budget now counts configs
		// actually read.
		const files: Record<string, string> = {
			"tsconfig.json": JSON.stringify({ extends: "./a" }),
		};
		const letters = ["a", "b", "c", "d", "e"];
		letters.forEach((letter, index) => {
			const next = letters[index + 1];
			files[`${letter}.json`] = JSON.stringify(
				next
					? { extends: `./${next}` }
					: { compilerOptions: { target: "ES2022" } },
			);
		});
		const chain = names(scratch(files));
		for (const letter of letters) {
			expect(chain, `${letter}.json must be watched`).toContain(
				`${letter}.json`,
			);
		}
	});

	it("resolves a package config published through `exports`", () => {
		// A config package with no `tsconfig.json` at the path the layout guess
		// builds reads as "no base config at all", which is how a live server ends
		// up on compiler options that moved.
		const root = scratch({
			"node_modules/@repo/tsconfig/package.json": JSON.stringify({
				name: "@repo/tsconfig",
				exports: { ".": "./base.json" },
			}),
			"node_modules/@repo/tsconfig/base.json": JSON.stringify({
				compilerOptions: { target: "ES2022" },
			}),
			"tsconfig.json": JSON.stringify({ extends: "@repo/tsconfig" }),
		});
		expect(names(root)).toContain("node_modules/@repo/tsconfig/base.json");
	});

	it("falls back to the manifest `main` when there is no exports map", () => {
		const root = scratch({
			"node_modules/@repo/tsconfig/package.json": JSON.stringify({
				name: "@repo/tsconfig",
				main: "./configs/base.json",
			}),
			"node_modules/@repo/tsconfig/configs/base.json": JSON.stringify({
				compilerOptions: { target: "ES2022" },
			}),
			"tsconfig.json": JSON.stringify({ extends: "@repo/tsconfig" }),
		});
		expect(names(root)).toContain(
			"node_modules/@repo/tsconfig/configs/base.json",
		);
	});

	it("still watches a relative base that does not exist yet", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({ extends: "./base.json" }),
		});
		expect(names(root)).toContain("base.json");
	});

	it("terminates on a config that extends itself", () => {
		const root = scratch({
			"tsconfig.json": JSON.stringify({ extends: "./tsconfig.json" }),
		});
		expect(names(root)).toEqual(["tsconfig.json"]);
	});
});

describe("tsConfigChain and the package manifest", () => {
	function names(root: string): string[] {
		return tsConfigChain(path.join(root, "tsconfig.json")).map((one) =>
			path.relative(root, one).split(path.sep).join("/"),
		);
	}

	it("prefers the `types` condition, as TypeScript does", () => {
		// TypeScript resolves an `extends` specifier with both `types` and
		// `require` in its condition set, so taking only one watches whichever
		// target the other would have won - and an edit to the config actually in
		// force then changes no stamp at all.
		const root = scratch({
			"node_modules/@repo/tsconfig/package.json": JSON.stringify({
				name: "@repo/tsconfig",
				exports: { ".": { types: "./typed.json", default: "./plain.json" } },
			}),
			"node_modules/@repo/tsconfig/typed.json": JSON.stringify({
				compilerOptions: { target: "ES2022" },
			}),
			"node_modules/@repo/tsconfig/plain.json": JSON.stringify({
				compilerOptions: { target: "ES5" },
			}),
			"tsconfig.json": JSON.stringify({ extends: "@repo/tsconfig" }),
		});
		const chain = names(root);
		expect(chain).toContain("node_modules/@repo/tsconfig/typed.json");
		expect(chain).not.toContain("node_modules/@repo/tsconfig/plain.json");
	});

	it("watches the manifest that decided which config that was", () => {
		// Editing `exports` remaps the target without touching either end of the
		// chain, so a fingerprint that skipped the manifest left the workspace on
		// the old base until something else happened to move.
		const root = scratch({
			"node_modules/@repo/tsconfig/package.json": JSON.stringify({
				name: "@repo/tsconfig",
				exports: { ".": "./base.json" },
			}),
			"node_modules/@repo/tsconfig/base.json": JSON.stringify({
				compilerOptions: { target: "ES2022" },
			}),
			"tsconfig.json": JSON.stringify({ extends: "@repo/tsconfig" }),
		});
		expect(names(root)).toContain("node_modules/@repo/tsconfig/package.json");
	});
});
