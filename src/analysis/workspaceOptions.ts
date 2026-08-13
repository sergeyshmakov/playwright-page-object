/**
 * What a caller asks a workspace for, and what a sweep reports back.
 *
 * Its own module because every other file in this cluster needs the shape and
 * none of them should have to reach up to the class to get it - the scope
 * normalizer and the project builder both run before a `Workspace` exists.
 */

export interface WorkspaceOptions {
	/** Absolute (or cwd-relative) directory that every emitted path is relative to. */
	projectRoot: string;
	tsconfig?: string;
	/**
	 * Explicit `playwright.config.*` path. Suppresses discovery entirely: a
	 * caller who names a config and silently gets a different one read is worse
	 * off than one told the file is missing.
	 */
	playwrightConfig?: string;
	include?: string[];
	exclude?: string[];
	maxFiles?: number;
	/** Overrides the `data-testid` attribute name; wins over playwright.config. */
	attribute?: string;
	/** Set to `false` to skip the per-call mtime sweep when batching tool calls. */
	revalidate?: boolean;
	staleAfterMs?: number;
	/** Extra module specifiers treated as the library (defaults to the package name). */
	libraryModules?: string[];
	preferSyntacticResolution?: boolean;
}

export interface RevalidateResult {
	changed: string[];
	added: string[];
	removed: string[];
}
