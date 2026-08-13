import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeEach, vi } from "vitest";
import { WorkspacePool } from "../../../analysis/workspace";
import {
	canLink,
	cleanupScratchRoots,
	scratchRepo,
	trackScratchRoot,
} from "./onDisk";

/**
 * Telling a linked workspace package apart from an installed dependency.
 *
 * npm, yarn and pnpm all publish a monorepo's own packages into `node_modules`
 * as symlinks (POSIX) or directory junctions (Windows). Classifying by the path
 * we walked to reach a file makes every one of those an external boundary, so a
 * repository whose components all come from `@company/ui` gets an empty tree
 * and is told its own source is a third-party dependency.
 *
 * These have to run against a real filesystem: ts-morph's in-memory host models
 * no links at all.
 */

/** One per spec file, so nothing leaks between them. */
export const pool = new WorkspacePool();

export function scratch(files: Record<string, string>): string {
	return scratchRepo(files, { prefix: "ppo-link-", real: true });
}

export const LINKS_WORK = canLink();

export function link(root: string, from: string, to: string): void {
	const linkPath = path.join(root, from);
	fs.mkdirSync(path.dirname(linkPath), { recursive: true });
	fs.symlinkSync(path.join(root, to), linkPath, "junction");
}

/**
 * A second spelling of `root`: a link beside it that points at it.
 *
 * The only portable way to hand the workspace a root whose `realpath` is a
 * different string — the mismatch macOS produces for free with `/var` versus
 * `/private/var`, and Windows produces whenever a repository is reached through
 * a junction or a `subst` drive.
 */
export function aliasOf(root: string): string {
	const alias = path.join(path.dirname(root), `${path.basename(root)}-alias`);
	fs.symlinkSync(root, alias, "junction");
	trackScratchRoot(alias);
	return alias;
}

/** A monorepo whose `@acme/ui` package is linked into `node_modules`. */
export const MONOREPO = {
	"tsconfig.json": JSON.stringify({
		compilerOptions: { jsx: "react-jsx", target: "ES2022" },
		include: ["apps"],
	}),
	"packages/ui/package.json": JSON.stringify({
		name: "@acme/ui",
		source: "src/index.tsx",
	}),
	"packages/ui/src/index.tsx": [
		"export function Gapped({ children }: { children?: unknown }) {",
		'\treturn <div data-testid="GappedRoot">{children as never}</div>;',
		"}",
		"",
	].join("\n"),
	"apps/web/src/App.tsx": [
		'import { Gapped } from "@acme/ui";',
		"export default function App() {",
		'\treturn <Gapped><span data-testid="Inner" /></Gapped>;',
		"}",
		"",
	].join("\n"),
};

beforeEach(() => {
	pool.clear();
	vi.restoreAllMocks();
});

afterAll(() => {
	cleanupScratchRoots();
});
