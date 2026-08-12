import { afterEach, describe, expect, it } from "vitest";
import { redirectConsoleToStderr, setLogLevel } from "../../mcp/logger";

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

	it("survives being applied twice without capturing itself", () => {
		// The second call must not record the *redirected* functions as the
		// originals, or the outer restore reinstates a redirect nobody can undo.
		const before = snapshot();
		const first = redirectConsoleToStderr();
		const second = redirectConsoleToStderr();
		second();
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
