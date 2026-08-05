/** Runtime options resolved from CLI flags (see src/cli.ts). */
export interface McpServerOptions {
	/** Repository root to analyze. Defaults to process.cwd() at the CLI layer. */
	projectRoot: string;
	/** Explicit tsconfig.json path; otherwise discovered by the engine. */
	tsconfig?: string;
	/** Restrict scanning to these directories (repeatable --src-dir flag). */
	srcDirs?: string[];
	/** Test-id attribute override (--attribute flag beats playwright.config). */
	attribute?: string;
	/** Cap on files parsed. */
	maxFiles?: number;
}
