import babel from "@rolldown/plugin-babel";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// Vite 8's oxc transformer (used by Vitest 4.1+) does not lower stage-3
	// decorators or the `accessor` keyword yet. Run Babel only on files that
	// contain a decorator (`filter: { code: "@" }`) to transpile them; oxc still
	// handles everything else. See https://github.com/vitejs/vite/discussions/21891
	plugins: [
		babel({
			presets: [
				{
					preset: () => ({
						plugins: [
							["@babel/plugin-proposal-decorators", { version: "2023-05" }],
						],
					}),
					rolldown: { filter: { code: "@" } },
				},
			],
		}),
	],
	test: {
		include: ["src/tests/**/*.spec.ts"],
		globals: true,
	},
});
