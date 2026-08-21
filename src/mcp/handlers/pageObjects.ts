import type * as z from "zod";
import {
	buildPageObjectTree,
	discoverPageObjects,
	findPageObjectTsConfigCandidates,
	type Workspace,
} from "../../analysis";
import { apiHintsFor } from "../api";
import { ToolError } from "../errors";
import { renderPageObjectOutline } from "../outline";
import { listEmptyHint } from "../present/hints";
import { summaryEntry } from "../present/pageObjects";
import { ok } from "../respond";
import type { getPageObjectTreeInput, listPageObjectsInput } from "../schemas";
import { relativizeFile } from "../target";
import {
	configFileOf,
	environmentHint,
	type ToolSession,
	withEnvironmentHint,
} from "../toolContext";
import { planWarnings } from "../warnings";

/**
 * What page objects exist, and what one of them looks like.
 */

export function handleListPageObjects(
	workspace: Workspace,
	args: z.infer<typeof listPageObjectsInput>,
	session: ToolSession = {},
) {
	const index = discoverPageObjects(workspace);
	let items = index.pageObjects;
	if (args.filter) {
		const needle = args.filter.toLowerCase();
		items = items.filter(
			(item) =>
				item.className.toLowerCase().includes(needle) ||
				item.file.toLowerCase().includes(needle),
		);
	}
	const total = items.length;
	const offset = args.offset;
	const shown = items.slice(offset, offset + args.limit);
	const end = offset + shown.length;
	const alternatives =
		index.pageObjects.length === 0
			? findPageObjectTsConfigCandidates(
					workspace.project,
					workspace.root,
					workspace.tsconfigPath,
					workspace.options.maxFiles,
				)
			: undefined;
	// Planned once and used everywhere below: the hint is built from the *full*
	// warnings, because `environmentHint` reads their `data`, and an abbreviated
	// warning has none. That split is the whole safety net - the advice survives
	// at full length however many times its warning has already been sent.
	const warnings = planWarnings(session.warnings, index.warnings);

	return ok(
		shown.map(summaryEntry),
		{
			root: index.projectRoot,
			tsconfig: index.tsconfig,
			tsconfigCandidates: alternatives?.candidates,
			tsconfigCandidatesTruncated: alternatives?.truncated,
			attribute: index.testIdAttribute,
			attributeSource: index.testIdAttributeSource,
			playwrightConfig: configFileOf(workspace),
			scanned: index.stats.filesScanned,
			// Always, not only when it overflows: a caller who cannot tell a
			// complete list from a capped one has to re-call to find out.
			total,
			offset: offset > 0 ? offset : undefined,
			nextOffset: end < total ? end : undefined,
			warnings: warnings.shown,
			hint: withEnvironmentHint(
				index.warnings,
				shown.length === 0
					? listEmptyHint(args.filter, offset, total, index.pageObjects, {
							tsconfig: index.tsconfig,
							scanned: index.stats.filesScanned,
							candidates: alternatives?.candidates ?? [],
							candidatesTruncated: alternatives?.truncated,
						})
					: undefined,
			),
		},
		{
			shrinkHint:
				"Re-call with a lower `limit`, a narrower `filter`, or page through with `offset`.",
			onDelivered: warnings.delivered,
		},
	);
}

export function handleGetPageObjectTree(
	workspace: Workspace,
	args: z.infer<typeof getPageObjectTreeInput>,
	session: ToolSession = {},
) {
	if (!args.class && !args.file) {
		throw new ToolError("invalid_input", "Provide `class`, `file`, or both.", {
			hint: 'Pass class (e.g. "CheckoutPage") or file. Call list_page_objects to see both.',
		});
	}

	const resolved = args.file
		? relativizeFile(workspace, args.file)
		: { file: undefined, note: undefined };

	const target =
		args.class && resolved.file
			? `${resolved.file}#${args.class}`
			: (args.class ?? resolved.file ?? "");

	const tree = buildPageObjectTree(workspace, target, {
		maxDepth: args.depth,
	});

	// Copied, never trimmed in place. The engine memoizes the tree and hands the
	// same object to every caller, so dropping the methods here would delete them
	// for the next call that asks for them — a response that silently loses a
	// section because an earlier call in the session passed includeMethods:false.
	const shown = args.includeMethods
		? tree
		: {
				...tree,
				defs: Object.fromEntries(
					Object.entries(tree.defs).map(([id, def]) => [
						id,
						{ ...def, methods: [] },
					]),
				),
			};

	const warnings = planWarnings(session.warnings, tree.warnings);
	// The same once-per-session rule the warnings beside it follow. It was 52% of
	// a small tree response and identical on every call; a repeat keeps the keys,
	// which name the bases in play, and drops the prose.
	const api = session.warnings
		? session.warnings.planText("apiHints", apiHintsFor(tree))
		: { shown: apiHintsFor(tree), delivered: () => {} };
	// Two fields, each with one type, rather than one field that changes type
	// between calls. `apiHints` is always the object of prose or absent; a repeat
	// puts the base names in `apiHintsSent` instead. A consumer that reads the
	// prose keeps a stable contract, and the repeat still costs a line.
	const apiFull = Array.isArray(api.shown) ? undefined : api.shown;
	const apiRepeated = Array.isArray(api.shown)
		? (api.shown as string[])
		: undefined;
	const meta = {
		root: tree.projectRoot,
		attribute: tree.testIdAttribute,
		attributeSource: tree.testIdAttributeSource,
		playwrightConfig: configFileOf(workspace),
		note: resolved.note,
		truncated: tree.truncated,
		// In meta, so both formats carry it: `outline` ships a string as its data,
		// and the call syntax is no less needed there. It describes how to *use*
		// what the tree found rather than being part of the finding.
		apiHints: apiFull,
		// Named for what it is: these bases were explained in full earlier this
		// session, so the prose is not repeated.
		apiHintsSent: apiRepeated,
		warnings: warnings.shown,
		hint: environmentHint(tree.warnings),
	};

	const shrink = {
		shrinkHint: `Re-call with format:"outline", a lower depth (this call used ${args.depth}), or includeMethods:false.`,
		onDelivered: () => {
			warnings.delivered();
			api.delivered();
		},
	};

	if (args.format === "outline") {
		return ok(renderPageObjectOutline(shown), meta, shrink);
	}

	return ok(
		{ root: shown.root, defs: shown.defs, stats: shown.stats },
		meta,
		shrink,
	);
}
