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
	 */
	it("refuses a handle minted against a different workspace instance", () => {
		const first = emptyProject();
		const second = emptyProject();
		const handles = new CoverageHandles();
		const id = handles.create(first, snapshot("first"));

		expect(second.currentEpoch).toBe(first.currentEpoch);
		expect(handles.resolve(id, second)).toEqual({
			ok: false,
			reason: "stale",
		});
	});

	it("expires a handle once the advertised TTL has passed", () => {
		const workspace = emptyProject();
		let clock = 1_000;
		const handles = new CoverageHandles(
			HANDLE_TTL_MS,
			MAX_HANDLES,
			() => clock,
		);
		const id = handles.create(workspace, snapshot("aging"));

		clock += HANDLE_TTL_MS;
		expect(handles.resolve(id, workspace).ok, "still inside the TTL").toBe(
			true,
		);

		clock += 1;
		expect(handles.resolve(id, workspace)).toEqual({
			ok: false,
			reason: "expired",
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
