import { randomBytes } from "node:crypto";
import type { CoverageReport, Workspace } from "../analysis";

/**
 * Opaque handles for the MCP "Stateful Tools" pattern: a creation tool returns
 * an id, and the follow-up tool takes that id in its *arguments* — which is
 * where the protocol puts cursors, since tool results themselves do not page.
 *
 * `map_coverage` mints one; `query_coverage` spends it.
 *
 * What the handle is NOT for: saving the recompute. The three engine builders
 * are memoized per epoch, so a repeat `map_coverage` with the same engine
 * arguments already costs ~60 ms. What it buys is that a paging walk is
 * *checked*: page 2 either describes the same report page 1 came from, or the
 * call fails with `expired_handle`. Paging with `{buckets:["x"], offset:N}`
 * across an edit silently skips and duplicates entries instead, and nothing in
 * the response says so.
 */

/**
 * How long a handle stays valid after its last use, absent any file change.
 *
 * Idle time, not age. Paging a 981-entry bucket at 50 a page is twenty calls,
 * and twenty calls at the pace an agent actually works crosses ten minutes —
 * so an absolute lifetime expired handles in the middle of exactly the walk
 * they exist to support. Refreshing on use is also what the policy always
 * meant: the TTL is a resource bound whose job is to release an *abandoned*
 * report, and a handle being spent is not abandoned.
 *
 * This is not the correctness guard and never was. That is the epoch check in
 * `resolve`, which refuses the handle the moment any analysed file changes,
 * however recently it was used — a handle can slide forever and still never
 * answer from a report that no longer describes the repository.
 *
 * The spec requires the creation tool to state the lifetime, so this number is
 * quoted in `map_coverage`'s description and in the server instructions — it
 * cannot be changed here alone.
 */
export const HANDLE_TTL_MS = 10 * 60_000;

/**
 * How many handles live at once.
 *
 * A handle holds the same `CoverageReport` object the workspace memo already
 * holds, so a live handle is nearly free; the cost only appears for a report
 * whose epoch has passed, and those are pruned rather than counted. The cap is
 * a backstop against a session that mints one per call, not a tuning knob.
 */
export const MAX_HANDLES = 8;

/** Header facts `map_coverage` resolved once, so a page can repeat them. */
export interface CoverageSnapshot {
	report: CoverageReport;
	attributeSource: string;
	assumeForwarded?: boolean;
	alsoIncluded?: string[];
	note?: string;
}

interface HandleEntry {
	snapshot: CoverageSnapshot;
	/**
	 * The instance, not just its root. `Workspace.acquire` keeps an LRU of two
	 * and a rebuilt workspace restarts its epoch at 0, so an id compared on
	 * `(root, epoch)` alone could be accepted by a *different* workspace whose
	 * counter happens to agree.
	 */
	workspace: Workspace;
	epoch: number;
	/** Refreshed by every successful `resolve`, so the TTL measures idleness. */
	lastUsedAt: number;
}

/** Why a handle could not be spent. Each gets its own message. */
export type HandleFailure = "unknown" | "expired" | "stale" | "rebuilt";

export type HandleLookup =
	| { ok: true; snapshot: CoverageSnapshot }
	| { ok: false; reason: HandleFailure };

/**
 * Bounded, in-memory, per-server. Nothing is written to disk and nothing
 * survives the process — an id from a previous session is simply `unknown`.
 */
export class CoverageHandles {
	/** Insertion-ordered, refreshed on a hit: iteration order is the LRU order. */
	private readonly entries = new Map<string, HandleEntry>();

	constructor(
		private readonly ttlMs: number = HANDLE_TTL_MS,
		private readonly maxHandles: number = MAX_HANDLES,
		private readonly now: () => number = Date.now,
	) {}

	create(workspace: Workspace, snapshot: CoverageSnapshot): string {
		this.prune(workspace);
		while (this.entries.size >= this.maxHandles) {
			const oldest = this.entries.keys().next();
			if (oldest.done) {
				break;
			}
			this.entries.delete(oldest.value);
		}
		const id = `cov_${randomBytes(8).toString("hex")}`;
		this.entries.set(id, {
			snapshot,
			workspace,
			epoch: workspace.currentEpoch,
			lastUsedAt: this.now(),
		});
		return id;
	}

	/**
	 * Resolves an id against the workspace *this* call acquired.
	 *
	 * Invalidation on an epoch bump is deliberate, and it is the interesting
	 * half of the design. Snapshot stability is the usual argument for a handle,
	 * and it points the other way: keep answering from the stored report and a
	 * paging walk stays internally consistent across an edit. It would also be a
	 * lie. Every entry in a coverage report carries a file and a line; a report
	 * built before an edit describes a repository that no longer exists, and
	 * this server's whole contract is that a result reflects the files on disk
	 * at the moment of the call. A stale page is not a smaller answer, it is a
	 * wrong one, and nothing in its shape says so.
	 *
	 * So the snapshot is kept only while it is still true, and the moment it
	 * stops being true the caller is told — recoverably, by re-minting. That
	 * turns the one failure a bare `{buckets, offset}` walk cannot detect into
	 * an error with a next move.
	 */
	resolve(id: string, workspace: Workspace): HandleLookup {
		const entry = this.entries.get(id);
		if (!entry) {
			return { ok: false, reason: "unknown" };
		}
		if (this.now() - entry.lastUsedAt > this.ttlMs) {
			this.entries.delete(id);
			return { ok: false, reason: "expired" };
		}
		// Two different failures, and they were reported as one. Identity differs
		// when the workspace was rebuilt - after the idle eviction released it, or
		// because this call analyses a different scope - and *nothing on disk
		// changed*. The epoch differs when a file really did change. Collapsing
		// them meant an eviction told the caller "the analysed sources changed on
		// disk", which is a specific claim about their repository and false.
		if (entry.workspace !== workspace) {
			this.entries.delete(id);
			return { ok: false, reason: "rebuilt" };
		}
		if (entry.epoch !== workspace.currentEpoch) {
			this.entries.delete(id);
			return { ok: false, reason: "stale" };
		}
		// Refresh both clocks: a handle being walked is the last one to evict, and
		// its idle timer starts again from here.
		entry.lastUsedAt = this.now();
		this.entries.delete(id);
		this.entries.set(id, entry);
		return { ok: true, snapshot: entry.snapshot };
	}

	/** Test hook. */
	get size(): number {
		return this.entries.size;
	}

	/**
	 * Drops what can no longer be spent, so a superseded report stops pinning
	 * the memory the workspace memo has already let go of.
	 */
	private prune(workspace: Workspace): void {
		const now = this.now();
		for (const [id, entry] of this.entries) {
			const dead =
				now - entry.lastUsedAt > this.ttlMs ||
				entry.workspace !== workspace ||
				entry.epoch !== workspace.currentEpoch;
			if (dead) {
				this.entries.delete(id);
			}
		}
	}
}

/**
 * The lifetime sentence, in full, written once.
 *
 * Quoted where a reader first meets a handle — `map_coverage`'s description,
 * which mints one, and the `expired_handle` hint, which is read by someone
 * holding a dead one.
 */
export const HANDLE_LIFETIME_TEXT = `A coverageId stays valid for ${HANDLE_TTL_MS / 60_000} minutes after its last use, for this server process only, so paging never times out mid-walk; it is invalidated as soon as any analysed file changes on disk, however recently it was used (a stale page would report lines that have moved). Spending an invalid one returns error code expired_handle; re-call map_coverage to mint a fresh id.`;

/**
 * The same fact as a clause, for the two places that have already said it.
 *
 * `tools/list` plus the instructions are resident in the model's context for
 * the whole session — measured at 15,899 B — and this sentence appeared in four
 * of them, ~1.4 KB to say one thing four times. Nothing is dropped: the full
 * text is one hop away in the tool that mints the handle.
 */
export const HANDLE_LIFETIME_CLAUSE = `A coverageId lasts ${HANDLE_TTL_MS / 60_000} minutes past its last use and dies the moment an analysed file changes; a dead one returns expired_handle, so re-call map_coverage for a fresh id.`;

/** The message body for each way a handle can fail, plus its recovery. */
export function handleFailureMessage(reason: HandleFailure): string {
	if (reason === "expired") {
		return `That coverageId has expired (handles live ${HANDLE_TTL_MS / 60_000} minutes past their last use, and this one was not used in that time).`;
	}
	if (reason === "stale") {
		return "The analysed sources changed on disk since that coverageId was issued, so the report it points at no longer describes the repository.";
	}
	if (reason === "rebuilt") {
		return "The analysis was rebuilt since that coverageId was issued - the workspace was released after an idle period, this call analyses a different scope, or a Playwright testDir / tsconfig edit changed which files the project holds - so the report it points at is no longer held. Nothing in your test-id sources necessarily changed.";
	}
	return `That coverageId is not known to this server (it may have expired, been evicted after ${MAX_HANDLES} newer handles, or come from a previous session).`;
}
