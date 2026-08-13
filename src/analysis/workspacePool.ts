import { foldPath } from "./util/paths";
import { Workspace, type WorkspaceOptions } from "./workspaceCore";
import { normalizeRoot, withNormalizedScope } from "./workspaceScope";

/**
 * Holding workspaces between calls.
 *
 * Everything here is policy about a *set* of workspaces rather than state of
 * one, which is why it is not on {@link Workspace}: how many are kept, how long
 * a silent one survives, and what identifies two callers as asking about the
 * same thing.
 */

const LRU_SIZE = 2;

/**
 * How long a cached workspace survives with nobody asking it anything.
 *
 * The LRU bounds how *many* workspaces are held, never how long. A stdio server
 * is one process holding one workspace for as long as the editor is open, so a
 * ts-morph `Project` over a large monorepo — measured at 645 MB on a 4,924-file
 * app and 867 MB at its repository root — stayed resident all day whether or
 * not another call ever came.
 *
 * Ten minutes of silence is an agent that has moved on. The cost of being wrong
 * is one cold rebuild (~2.3 s) on the next call; the cost of not doing it is
 * half a gigabyte held against a developer's machine indefinitely.
 *
 * It matches {@link HANDLE_TTL_MS} in the MCP layer deliberately: both are idle
 * timers over the same activity, so an idle session releases its workspace and
 * its coverage handles together instead of one outliving the other. Eviction is
 * safe for a live handle in any case — the store compares workspace identity
 * and returns a recoverable `expired_handle`.
 */
const IDLE_EVICT_AFTER_MS = 10 * 60_000;

/**
 * Cache identity. Every option that changes what the workspace *contains* or
 * how it is analysed belongs here: reusing a workspace built with a laxer
 * `maxFiles` would silently defeat a later caller's safety cap.
 *
 * `revalidate` and `staleAfterMs` are deliberately absent. They say how fresh
 * *this* call needs the answer, not what the workspace holds, so keying on them
 * would build a second project over the same files; {@link Workspace.acquire}
 * applies the incoming value to the cached workspace instead.
 */
function workspaceKey(options: WorkspaceOptions): string {
	return [
		foldPath(normalizeRoot(options.projectRoot)),
		options.tsconfig ?? "",
		options.playwrightConfig ?? "",
		(options.include ?? []).join(","),
		(options.exclude ?? []).join(","),
		options.attribute ?? "",
		options.maxFiles ?? "",
		(options.libraryModules ?? []).join(","),
		options.preferSyntacticResolution ?? "",
	].join("::");
}

/**
 * Which workspaces are kept, and for how long.
 *
 * Split off {@link Workspace} because it is policy about a *set* of workspaces,
 * not state of one, and because the previous home for it was a static cache —
 * a process-wide global serving a single production caller. It matches
 * `CoverageHandles` in the MCP layer, which is constructed per server for the
 * same reason and with the same injected bounds; the two idle timers are meant
 * to be read together (see {@link IDLE_EVICT_AFTER_MS}).
 *
 * One pool per server means a second server in the same process — the in-memory
 * transport every MCP test boots — shares nothing with the first, so hermeticity
 * is a property of construction rather than of remembering to call a reset.
 */
export class WorkspacePool {
	/** Insertion-ordered, refreshed on a hit: iteration order is the LRU order. */
	private readonly cache = new Map<string, Workspace>();
	/** Keyed like {@link cache}, so eviction and the timer cannot disagree. */
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(
		private readonly maxSize: number = LRU_SIZE,
		private readonly idleMs: number = IDLE_EVICT_AFTER_MS,
	) {}

	/** Keyed by root + tsconfig + include/exclude. See {@link workspaceKey}. */
	acquire(rawOptions: WorkspaceOptions): Workspace {
		const { options, missing } = withNormalizedScope(rawOptions);
		const key = workspaceKey(options);
		const existing = this.cache.get(key);
		if (existing) {
			// Refresh recency.
			this.cache.delete(key);
			this.cache.set(key, existing);
			if (existing.reuseFor(options, missing)) {
				this.hold(key, existing);
				return existing;
			}
			this.drop(key);
		}

		const created = Workspace.build(options, missing);
		this.cache.set(key, created);
		this.hold(key, created);
		while (this.cache.size > this.maxSize) {
			const oldest = this.cache.keys().next();
			if (oldest.done) {
				break;
			}
			this.drop(oldest.value);
		}
		return created;
	}

	/** Drops every cached workspace, and every pending eviction with it. */
	clear(): void {
		for (const key of [...this.cache.keys()]) {
			this.drop(key);
		}
	}

	get size(): number {
		return this.cache.size;
	}

	/**
	 * Everything this pool does to a workspace it is about to hand out: restart
	 * the idle countdown, and re-arm the escape hatch the workspace uses if it
	 * discovers mid-call that it must not be handed out again.
	 *
	 * The countdown restarts on every acquire, so the timer measures silence
	 * rather than age — a session in continuous use never evicts.
	 */
	private hold(key: string, workspace: Workspace): void {
		workspace.heldBy(() => {
			// Only this exact instance: a rebuild under the same key must not be
			// dropped by its predecessor.
			if (this.cache.get(key) === workspace) {
				this.drop(key);
			}
		});
		this.clearTimer(key);
		const timer = setTimeout(() => {
			this.timers.delete(key);
			// Only if this exact instance is still the cached one: a rebuild under
			// the same key must not be evicted by its predecessor's timer.
			if (this.cache.get(key) === workspace) {
				this.cache.delete(key);
			}
		}, this.idleMs);
		// `unref`ed, so a pending eviction never holds the process open — a CLI
		// that has answered its one question still exits immediately.
		timer.unref?.();
		this.timers.set(key, timer);
	}

	private drop(key: string): void {
		this.clearTimer(key);
		this.cache.delete(key);
	}

	private clearTimer(key: string): void {
		const timer = this.timers.get(key);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.timers.delete(key);
		}
	}
}
