import { defineConfig } from "tsup";

// NOTE: array configs build CONCURRENTLY and `clean: true` wipes the whole
// outDir, so cleaning lives in the `prebuild` script (run/clean-dist.mjs).
// `target` is intentionally unset: tsup reads es2022 from tsconfig.json.
export default defineConfig([
	{
		entry: ["src/index.ts"],
		format: ["cjs", "esm"],
		dts: true,
		clean: false,
	},
]);
