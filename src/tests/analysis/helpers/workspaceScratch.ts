import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { toPosix } from "../../../analysis/util/paths";
import type { Workspace } from "../../../analysis/workspace";
import { WorkspacePool } from "../../../analysis/workspace";
import { cleanupScratchRoots, scratchRepo } from "./onDisk";

/**
 * A throwaway repository on disk, and the pool that analyses it.
 *
 * Shared by the five `workspace*.spec.ts` files, which were one file until the
 * 500-line limit. The hooks are deliberately *not* registered here: a
 * `beforeEach` called at import time of a shared module is context-dependent in
 * vitest, so each spec registers {@link clearPool} and {@link cleanupWorkspaces}
 * itself.
 */

/** One per spec file, so nothing leaks between them. */
export const pool = new WorkspacePool();

/**
 * The `fs` ts-morph reads through.
 *
 * Its own `require("fs")` object, not this file's ESM namespace: the namespace
 * is frozen and cannot be spied on, while the CJS exports every dependency
 * shares can be swapped for the length of one call. It is the only way to see
 * *whether a file was parsed at all*, which is the whole difference between a
 * cap checked before the parse and one checked after it.
 */
export const readingFs = createRequire(
	path.join(process.cwd(), "package.json"),
)("node:fs") as typeof fs;

export function scratch(files: Record<string, string>): string {
	return scratchRepo(files, { prefix: "ppo-ws-" });
}

/** Workspace-relative posix paths of everything the workspace analyses. */
export function rels(ws: Workspace): string[] {
	return ws.sourceFiles().map((file) => ws.rel(file.getFilePath()));
}

/** Absolute posix paths every `readFileSync` saw while `body` ran. */
export function recordingReads(body: () => void): string[] {
	const reads: string[] = [];
	const original = readingFs.readFileSync;
	(readingFs as { readFileSync: unknown }).readFileSync = (
		target: never,
		options: never,
	) => {
		reads.push(toPosix(String(target)));
		return original(target, options);
	};
	try {
		body();
	} finally {
		(readingFs as { readFileSync: unknown }).readFileSync = original;
	}
	return reads;
}

/** mtimeMs has coarse resolution on some filesystems; stamp it explicitly. */
export function touch(
	root: string,
	relativePath: string,
	secondsAhead: number,
): void {
	const absolute = path.join(root, relativePath);
	const when = new Date(Date.now() + secondsAhead * 1000);
	fs.utimesSync(absolute, when, when);
}

export function clearPool(): void {
	pool.clear();
}

export function cleanupWorkspaces(): void {
	pool.clear();
	cleanupScratchRoots();
}
