/**
 * The analysed workspace, as one import path.
 *
 * Forty modules and a dozen specs import `Workspace`, `WorkspacePool` and
 * `isJsxFile` from here, and the pool needs the class as a value - so the
 * module they name cannot be the one that defines either. It is a barrel
 * instead, and neither side imports it. Same shape, and for the same reason, as
 * `mcp/tools.ts`.
 *
 * - `./workspaceCore` - the `Workspace` class itself.
 * - `./workspaceFiles` - its base: the `Project` and everything read off it.
 * - `./workspaceOptions` - what a caller asks for, and what a sweep reports.
 * - `./workspacePool` - which workspaces are kept, and for how long.
 * - `./workspaceScope` - what a caller asked to analyse, as globs.
 * - `./workspaceBuild` - what a new workspace's `Project` will hold.
 */

export { Workspace } from "./workspaceCore";
export { DEFAULT_TEST_ID_ATTRIBUTE } from "./workspaceFiles";
export type {
	RevalidateResult,
	WorkspaceOptions,
} from "./workspaceOptions";
export { WorkspacePool } from "./workspacePool";
export { isJsxFile } from "./workspaceScope";
