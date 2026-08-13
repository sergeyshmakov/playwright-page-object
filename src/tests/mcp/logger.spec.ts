import { afterEach, describe, expect, it } from "vitest";
import {
	logger,
	pushLogLevel,
	redirectConsoleToStderr,
	setLogLevel,
} from "../../mcp/logger";

/**
 * Taking over `console` is the last line of defence against a transitive
 * dependency writing to stdout, which on this transport is the JSON-RPC
 * channel - one stray `console.log` and the client sees a parse error.
 *
 * It is also a global mutation of a process the caller may not own. Through
 * the exported `runMcpServer`, a host application's own logging is taken over
 * for as long as the server runs, so the way back has to exist and has to be
 * safe to call twice.
 */

const METHODS = ["log", "info", "debug", "warn"] as const;

function snapshot() {
	return METHODS.map((name) => console[name]);
}

afterEach(() => {
	setLogLevel("error");
});

describe("redirectConsoleToStderr", () => {
	it("replaces the four methods and puts them back", () => {
		const before = snapshot();
		const restore = redirectConsoleToStderr();
		expect(snapshot(), "each method is taken over").not.toEqual(before);
		restore();
		expect(snapshot()).toEqual(before);
	});

	it("survives being applied twice and closed innermost-first", () => {
		// The second call must not record the *redirected* functions as the
		// originals, or the outer restore reinstates a redirect nobody can undo.
		const before = snapshot();
		const first = redirectConsoleToStderr();
		const second = redirectConsoleToStderr();
		second();
		first();
		expect(snapshot()).toEqual(before);
	});

	it("survives being closed outermost-first", () => {
		// The order the previous test does *not* cover, and the one the first
		// version of this got wrong: two servers in a host process close whenever
		// their own work is done, not in the order they opened. Capturing the
		// originals per activation makes the second capture record the first
		// redirect, so closing first-then-second reinstalls a redirect over a dead
		// transport instead of handing the host its console back.
		const before = snapshot();
		const first = redirectConsoleToStderr();
		const second = redirectConsoleToStderr();
		first();
		expect(snapshot(), "the second server is still serving").not.toEqual(
			before,
		);
		second();
		expect(snapshot()).toEqual(before);
	});

	it("keeps the redirect up while any server is still serving", () => {
		const before = snapshot();
		const first = redirectConsoleToStderr();
		const second = redirectConsoleToStderr();
		const third = redirectConsoleToStderr();
		second();
		third();
		expect(snapshot(), "one is still up").not.toEqual(before);
		first();
		expect(snapshot()).toEqual(before);
	});

	it("is safe to call twice", () => {
		const before = snapshot();
		const restore = redirectConsoleToStderr();
		restore();
		restore();
		expect(snapshot()).toEqual(before);
	});

	it("leaves a method someone else replaced after us alone", () => {
		// A caller that installs its own logging while the server runs owns the
		// method. Handing back a function captured before that would be this same
		// bug pointed the other way.
		const before = console.log;
		const restore = redirectConsoleToStderr();
		const theirs = () => {};
		console.log = theirs;
		restore();
		expect(console.log).toBe(theirs);
		console.log = before;
	});

	it("routes a redirected call to stderr rather than stdout", () => {
		setLogLevel("debug");
		const chunks: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		const outOriginal = process.stdout.write.bind(process.stdout);
		let stdoutWrites = 0;
		(process.stderr as { write: unknown }).write = (chunk: string) => {
			chunks.push(String(chunk));
			return true;
		};
		(process.stdout as { write: unknown }).write = (chunk: string) => {
			stdoutWrites += 1;
			return outOriginal(chunk);
		};
		const restore = redirectConsoleToStderr();
		try {
			console.log("hello");
		} finally {
			restore();
			(process.stderr as { write: unknown }).write = original;
			(process.stdout as { write: unknown }).write = outOriginal;
		}
		expect(chunks.join("")).toContain("hello");
		expect(stdoutWrites, "stdout is the JSON-RPC channel").toBe(0);
	});
});

describe("pushLogLevel", () => {
	function emitted(body: () => void): string {
		const chunks: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		(process.stderr as { write: unknown }).write = (chunk: string) => {
			chunks.push(String(chunk));
			return true;
		};
		try {
			body();
		} finally {
			(process.stderr as { write: unknown }).write = original;
		}
		return chunks.join("");
	}

	it("does not let a second server silence the first", () => {
		// One module-level variable, two servers. Plain assignment meant the
		// second server's level replaced the first's for both, so mounting a
		// `silent` server alongside a running one suppressed that one's errors.
		const loud = pushLogLevel("debug");
		const quiet = pushLogLevel("silent");
		expect(emitted(() => logger.debug("still here"))).toContain("still here");
		quiet();
		loud();
	});

	it("restores the level when a server closes", () => {
		const release = pushLogLevel("debug");
		release();
		expect(emitted(() => logger.debug("gone"))).toBe("");
	});

	it("keeps the loudest level while any server wants it", () => {
		const first = pushLogLevel("debug");
		const second = pushLogLevel("error");
		second();
		expect(emitted(() => logger.debug("first still wants this"))).toContain(
			"first still wants this",
		);
		first();
		expect(emitted(() => logger.debug("nobody wants this"))).toBe("");
	});

	it("is safe to release twice", () => {
		const first = pushLogLevel("debug");
		const second = pushLogLevel("debug");
		second();
		second();
		expect(
			emitted(() => logger.debug("one is still up")),
			"a double release must not drop the other server's level",
		).toContain("one is still up");
		first();
	});
});

describe("a lone silent server", () => {
	function emitted(body: () => void): string {
		const chunks: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		(process.stderr as { write: unknown }).write = (chunk: string) => {
			chunks.push(String(chunk));
			return true;
		};
		try {
			body();
		} finally {
			(process.stderr as { write: unknown }).write = original;
		}
		return chunks.join("");
	}

	it("is actually silent", () => {
		// Seeding the reduction with the default made it a floor: `error` is more
		// verbose than `silent`, so the only server asking for silence got `error`
		// and `--log-level silent` did nothing at all.
		const release = pushLogLevel("silent");
		expect(emitted(() => logger.error("should not appear"))).toBe("");
		release();
	});

	it("still yields to a louder server while one is up", () => {
		const quiet = pushLogLevel("silent");
		const loud = pushLogLevel("debug");
		expect(
			emitted(() => logger.error("the other server wants this")),
		).toContain("the other server wants this");
		loud();
		expect(emitted(() => logger.error("back to silence"))).toBe("");
		quiet();
	});
});
