import { describe, expect, it } from "vitest";
import type { CoverageReport } from "../../analysis";
import {
	CoverageHandles,
	HANDLE_LIFETIME_TEXT,
	HANDLE_TTL_MS,
	handleFailureMessage,
	MAX_HANDLES,
} from "../../mcp/handles";
import { makeWorkspace } from "../analysis/helpers/inMemory";

/**
 * The handle store, whose interesting behaviour is all in what it *refuses*.
 * A handle that keeps answering after the sources moved is worse than no
 * handle at all: every entry in a coverage report carries a file and a line.
 */

function snapshot(tag: string) {
	return {
		report: { tag } as unknown as CoverageReport,
		attributeSource: "default",
	};
}

const emptyProject = () => makeWorkspace({ "src/a.ts": "export const a = 1;" });

describe("CoverageHandles", () => {
	it("mints an opaque id that resolves back to the stored snapshot", () => {
		const workspace = emptyProject();
		const handles = new CoverageHandles();
		const id = handles.create(workspace, snapshot("first"));

		expect(id).toMatch(/^cov_[0-9a-f]{16}$/);
		const found = handles.resolve(id, workspace);
		expect(found.ok).toBe(true);
		expect(found.ok && found.snapshot.report).toEqual({ tag: "first" });
	});

	it("reports an id it never issued as unknown", () => {
		const handles = new CoverageHandles();
		const found = handles.resolve("cov_deadbeefdeadbeef", emptyProject());
		expect(found).toEqual({ ok: false, reason: "unknown" });
	});

	/**
	 * The design call this store exists to make. A bumped epoch means a file
	 * changed on disk, so the stored report describes a repository that is gone;
	 * continuing to page it would hand back line numbers that have moved with
	 * nothing in the response saying so.
	 */
	it("invalidates a handle as soon as the workspace epoch moves", () => {
		const workspace = emptyProject();
		const handles = new CoverageHandles();
		const id = handles.create(workspace, snapshot("before"));
		expect(handles.resolve(id, workspace).ok).toBe(true);

		workspace.bumpEpoch();

		expect(handles.resolve(id, workspace)).toEqual({
			ok: false,
			reason: "stale",
		});
		// And it is dropped, not merely refused: a superseded report must stop
		// pinning the memory the workspace memo has already let go of.
		expect(handles.size).toBe(0);
	});

	/**
	 * A rebuilt workspace restarts its epoch at 0, so `(root, epoch)` can repeat.
	 * Identity is what actually distinguishes the two.
	 *
	 * And it is `rebuilt`, not `stale`: the two used to share a reason, so an
	 * idle eviction told the caller "the analysed sources changed on disk" — a
	 * specific claim about their repository, made when nothing on disk had moved.
	 */
	it("refuses a handle minted against a different workspace instance", () => {
		const first = emptyProject();
		const second = emptyProject();
		const handles = new CoverageHandles();
		const id = handles.create(first, snapshot("first"));

		expect(second.currentEpoch).toBe(first.currentEpoch);
		expect(handles.resolve(id, second)).toEqual({
			ok: false,
			reason: "rebuilt",
		});
	});

	it("tells a rebuild apart from a source change, in the message too", () => {
		expect(handleFailureMessage("rebuilt")).toContain("rebuilt");
		expect(handleFailureMessage("rebuilt")).toContain(
			"Nothing in your sources necessarily changed",
		);
		// The claim that must only be made when it is true.
		expect(handleFailureMessage("rebuilt")).not.toContain("changed on disk");
		expect(handleFailureMessage("stale")).toContain("changed on disk");
	});

	it("expires a handle once the advertised TTL has passed unused", () => {
		const workspace = emptyProject();
		let clock = 1_000;
		const handles = new CoverageHandles(
			HANDLE_TTL_MS,
			MAX_HANDLES,
			() => clock,
		);
		const id = handles.create(workspace, snapshot("aging"));

		// Deliberately not resolved in between: the clock the TTL reads is idle
		// time since the last use, and touching the handle here would restart it.
		clock += HANDLE_TTL_MS + 1;
		expect(handles.resolve(id, workspace)).toEqual({
			ok: false,
			reason: "expired",
		});
	});

	it("counts the TTL from the last use, not from the mint", () => {
		const workspace = emptyProject();
		let clock = 1_000;
		const handles = new CoverageHandles(
			HANDLE_TTL_MS,
			MAX_HANDLES,
			() => clock,
		);
		const id = handles.create(workspace, snapshot("aging"));

		clock += HANDLE_TTL_MS;
		expect(handles.resolve(id, workspace).ok, "just inside the TTL").toBe(true);

		// One past the TTL measured from the *mint*, and a millisecond past the
		// last use: the old absolute clock refused this, the idle clock allows it.
		clock += 1;
		expect(handles.resolve(id, workspace).ok, "refreshed by that use").toBe(
			true,
		);
	});

	/**
	 * The TTL measures idleness, not age. Twenty pages of a long bucket at the
	 * pace an agent works crosses ten minutes, and an absolute lifetime expired
	 * the handle in the middle of the walk it exists to support.
	 */
	it("keeps a handle alive as long as it is being used", () => {
		const workspace = emptyProject();
		let clock = 1_000;
		const handles = new CoverageHandles(
			HANDLE_TTL_MS,
			MAX_HANDLES,
			() => clock,
		);
		const id = handles.create(workspace, snapshot("walking"));

		// Twenty pages, nine minutes apart: three hours of wall clock, none of it
		// idle for longer than the TTL.
		for (let page = 0; page < 20; page += 1) {
			clock += HANDLE_TTL_MS - 60_000;
			expect(handles.resolve(id, workspace).ok, `page ${page}`).toBe(true);
		}

		// Abandoning it still expires it, from the last use rather than the mint.
		clock += HANDLE_TTL_MS + 1;
		expect(handles.resolve(id, workspace)).toEqual({
			ok: false,
			reason: "expired",
		});
	});

	/**
	 * The guard that stops the sliding TTL becoming a licence to serve stale
	 * reports. Freshness is the epoch's job, not the clock's: a handle used one
	 * millisecond ago is refused the moment the sources move, because every
	 * entry in the report it points at carries a line number that has shifted.
	 */
	it("refuses a handle whose sources changed, however recently it was used", () => {
		const workspace = emptyProject();
		let clock = 1_000;
		const handles = new CoverageHandles(
			HANDLE_TTL_MS,
			MAX_HANDLES,
			() => clock,
		);
		const id = handles.create(workspace, snapshot("fresh"));

		clock += 1;
		expect(handles.resolve(id, workspace).ok).toBe(true);

		workspace.bumpEpoch();
		clock += 1;
		expect(handles.resolve(id, workspace)).toEqual({
			ok: false,
			reason: "stale",
		});
	});

	/**
	 * Eviction order is LRU rather than plain insertion order, because the handle
	 * an agent is walking is the one it mints first and touches most.
	 */
	it("evicts the least recently used handle past the cap", () => {
		const workspace = emptyProject();
		const handles = new CoverageHandles();
		const ids = Array.from({ length: MAX_HANDLES }, (_, index) =>
			handles.create(workspace, snapshot(`n${index}`)),
		);
		expect(handles.size).toBe(MAX_HANDLES);

		// Touching the oldest moves it to the back of the eviction queue.
		expect(handles.resolve(ids[0], workspace).ok).toBe(true);
		const extra = handles.create(workspace, snapshot("extra"));

		expect(handles.size).toBe(MAX_HANDLES);
		expect(handles.resolve(ids[0], workspace).ok, "recently paged").toBe(true);
		expect(handles.resolve(extra, workspace).ok, "just minted").toBe(true);
		expect(handles.resolve(ids[1], workspace)).toEqual({
			ok: false,
			reason: "unknown",
		});
	});

	it("gives each failure its own message, and quotes the real TTL", () => {
		expect(handleFailureMessage("expired")).toContain("10 minutes");
		expect(handleFailureMessage("stale")).toContain("changed on disk");
		expect(handleFailureMessage("unknown")).toContain("not known");
		// The spec requires the creation tool to state the lifetime; the sentence
		// the descriptions quote is derived from the constant so the two cannot
		// drift apart.
		expect(HANDLE_LIFETIME_TEXT).toContain(`${HANDLE_TTL_MS / 60_000} minutes`);
		expect(HANDLE_LIFETIME_TEXT).toContain("expired_handle");
	});
});
