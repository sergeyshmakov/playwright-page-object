import type { Diagnostic, Workspace } from "../analysis";
import type { WarningLedger } from "./warnings";

/**
 * What a handler knows before it reads any argument: the per-server state,
 * and the one place an engine diagnostic becomes advice about a CLI flag.
 */

/**
 * The per-server state a tool call may consult.
 *
 * Optional throughout, so a handler called without one behaves exactly as it
 * did before sessions existed - which is what makes the handlers callable
 * directly, with a `Workspace` and nothing else, rather than only through a
 * booted server.
 *
 * `src/tests/mcp/handlers.spec.ts` is that caller: it asks what a payload
 * contains without booting anything, and it is the only place the session's own
 * behaviour - a warning sent in full once and abbreviated after - is visible,
 * because that only appears across two calls sharing one ledger.
 */
export interface ToolSession {
	warnings?: WarningLedger;
}

/**
 * Thin tool handlers: validate cross-field rules, call the analysis engine,
 * shape a token-lean payload, wrap in the response envelope.
 */

/**
 * Turns an environment diagnostic into the flag that fixes it.
 *
 * The engine deliberately names no CLI option — it is consumed by more than one
 * surface — but an agent holding a wrong answer needs a concrete next move, and
 * "the attribute is wrong" without "restart with `--attribute data-tid`" is a
 * dead end. This is the one place that translation happens, and it goes in
 * front of every per-tool hint: no advice about which tool to call next matters
 * while the analysis is reading the wrong attribute.
 */
export function environmentHint(
	warnings: Diagnostic[] | undefined,
): string | undefined {
	if (!warnings || warnings.length === 0) {
		return undefined;
	}
	const byCode = (code: string): Diagnostic | undefined =>
		warnings.find((warning) => warning.code === code);

	const mismatch = byCode("attribute-mismatch");
	if (mismatch) {
		const candidate = String(mismatch.data?.candidate ?? "");
		return `The test-id attribute is almost certainly wrong: nothing in the scanned sources uses "${mismatch.data?.attribute}", while "${candidate}" is everywhere. Restart the server with --attribute ${candidate}, or with --playwright-config <file> pointing at the config that sets use.testIdAttribute. Treat this result as unreliable until then.`;
	}

	const blind = byCode("scope-empty") ?? byCode("attribute-no-evidence");
	if (blind) {
		return blind.code === "scope-empty"
			? "No JSX/TSX sources were scanned, so no rendered test id can be found and every selector will look unmatched. Restart the server with --src-dir <dir> (or --project-root <dir>) covering the application sources."
			: `No element in the scanned sources uses the "${blind.data?.attribute}" attribute. Restart the server with --src-dir <dir> so the application sources are in scope, or with --attribute <name> if the sources use a different one.`;
	}

	const missing = warnings.find(
		(warning) =>
			warning.code === "scope-dir-missing" && warning.severity !== "info",
	);
	if (missing) {
		return `The scanned directory "${missing.data?.path}" does not exist, so the analysis saw less than you think. Restart the server with a --src-dir that is on disk.`;
	}

	const ambiguous = warnings.find(
		(warning) =>
			warning.code === "playwright-config-ambiguous" &&
			warning.severity === "warning",
	);
	if (ambiguous) {
		return `${ambiguous.data?.count} Playwright configs were found and none of them sets use.testIdAttribute; ${ambiguous.data?.chosen} was read. If the attribute lives elsewhere, restart the server with --playwright-config <file>.`;
	}

	const conflict = byCode("testid-attribute-conflict");
	if (conflict) {
		return `Two Playwright configs disagree about use.testIdAttribute. Restart the server with --playwright-config <file> to pin the one your tests run with.`;
	}

	// Last, and only at warning severity — that is the run with dead selectors in
	// it, where the reader is about to act on a list the scope makes unreliable.
	// It also names the one flag that works: `--src-dir` outside `--project-root`
	// is refused at startup (validateServerOptions), so the natural reading of
	// "add their directories to the scan" is advice that kills the server.
	const scope = warnings.find(
		(warning) =>
			warning.code === "ui-scope-incomplete" && warning.severity === "warning",
	);
	const sourceRoot = scope?.data?.sourceRoot;
	if (typeof sourceRoot === "string") {
		return `Dead selectors in this report are unverified: ${scope?.data?.tags} component tag(s) render from modules whose sources live at "${sourceRoot}", outside this server's --project-root. Restart with --project-root ${sourceRoot} to include them. Adding them with --src-dir will not work — a --src-dir outside the project root is refused at startup.`;
	}

	// Its sibling above names `--project-root` exactly and even pre-empts the
	// wrong flag; this one said "re-run assuming forwarding" and named nothing,
	// so the one piece of advice a reader could not act on was the one whose fix
	// is a single tool argument. A server flag still supplies the default, but a
	// per-call override is what lets an MCP client compare both answers in place.
	const forwarding = byCode("forwarding-unproven-widespread");
	if (forwarding) {
		return `${forwarding.data?.unproven} of ${forwarding.data?.selectors} test-id selector(s) match only ids written as component props, which is what a component library that forwards props as a matter of course looks like. If yours does, re-call map_coverage with assumeForwarded: true to count them as matches. Every id and match it changes is labelled in the response; assumeForwarded: false restores the conservative answer even when the server started with --assume-forwarded.`;
	}

	return undefined;
}

/**
 * Warnings minus the ones that describe a node tree, for a response that ships
 * none.
 *
 * `tree-partial` says where the *walk* stopped, in terms of `roots`. It is the
 * right thing to say next to a tree and wrong next to anything else: a `testId`
 * lookup answers from the flat inventory, which is complete in every fidelity
 * mode, so the caveat lands on the one part of the analysis it does not apply
 * to. The same reasoning removes it from coverage, one layer down in
 * `buildCoverageReport`.
 */
export function withoutTreeShapeWarnings(warnings: Diagnostic[]): Diagnostic[] {
	return warnings.filter((warning) => warning.code !== "tree-partial");
}

/** Prepends the environment hint, so it is read before any per-tool advice. */
export function withEnvironmentHint(
	warnings: Diagnostic[] | undefined,
	hint: string | undefined,
): string | undefined {
	const environment = environmentHint(warnings);
	if (!environment) {
		return hint;
	}
	return hint ? `${environment} ${hint}` : environment;
}

/** Config file the analysis actually read, for `meta.playwrightConfig`. */
export function configFileOf(workspace: Workspace): string | undefined {
	return workspace.playwright().configFile ?? undefined;
}

/**
 * What to say when a tool found nothing, or found the wrong thing.
 *
 * An empty answer is the one an agent is most likely to act on wrongly - it
 * reads as "there is nothing here" when it usually means "you asked the wrong
 * question" - so each of these turns a count into the next call to make.
 *
 * Pure over the engine's summaries and plain counts, and therefore testable as
 * a table rather than through a repository built to produce a zero.
 */
