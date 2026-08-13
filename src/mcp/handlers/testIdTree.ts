import type * as z from "zod";
import {
	buildTestIdTree,
	type ComponentInfo,
	isCatchAllPattern,
	scannedComponents,
	type Workspace,
} from "../../analysis";
import { ToolError } from "../errors";
import { renderTestIdOutline } from "../outline";
import {
	blindScan,
	gapHint,
	idsNotPlaced,
	subtreeStats,
	traversalGap,
} from "../present/gaps";
import { lookupHint, missingComponent } from "../present/hints";
import { isScannedFile } from "../present/paths";
import { ok } from "../respond";
import type { getTestIdTreeInput } from "../schemas";
import { resolveEntryFile } from "../target";
import {
	configFileOf,
	type ToolSession,
	withEnvironmentHint,
	withoutTreeShapeWarnings,
} from "../toolContext";
import { planWarnings } from "../warnings";

/**
 * The rendered test-id tree, and looking one id up in it.
 */

export function handleGetTestIdTree(
	workspace: Workspace,
	args: z.infer<typeof getTestIdTreeInput>,
	session: ToolSession = {},
) {
	// `followComponents` is a real engine option now, so it no longer has to be
	// faked as `depth: 1`. That collapse reported every component boundary as
	// `depth-limit-reached` and set `truncated`, telling callers a budget had run
	// out when they had simply asked for one level.
	const depth = args.depth;
	const followComponents = args.followComponents;
	// Before anything reads it, and whatever the call goes on to ask for: a
	// `file` naming nothing is the caller's mistake in every branch.
	const scope = args.file ? resolveEntryFile(workspace, args.file) : undefined;

	if (args.testId) {
		// A lookup answers from the flat inventory, which is complete whatever the
		// walk did. `followComponents` shapes the tree, so narrowing the lookup by
		// it would answer "not rendered" about a file the walk simply skipped.
		const tree = buildTestIdTree(workspace, {
			attribute: args.attribute,
			maxDepth: depth,
		});
		const needle = args.testId;
		// A pattern that matches everything matches this too, and reporting it as
		// a hit tells a caller their id is rendered at a line where the source
		// writes `data-testid={anything}`. Counted separately so the answer can
		// say what it left out instead of pretending there was nothing.
		let catchAllSkipped = 0;
		const occurrences = tree.inventory.filter((occurrence) => {
			if (occurrence.value.kind === "static") {
				return occurrence.value.value === needle;
			}
			if (occurrence.value.kind === "pattern" && occurrence.value.regex) {
				if (isCatchAllPattern(occurrence.value.regex.source)) {
					catchAllSkipped += 1;
					return false;
				}
				return new RegExp(
					occurrence.value.regex.source,
					occurrence.value.regex.flags,
				).test(needle);
			}
			return false;
		});
		const propOnly =
			occurrences.length > 0 &&
			occurrences.every((occurrence) => occurrence.reach === "component-prop");
		// Pattern families the needle names the head of, for the empty-result hint.
		const families =
			occurrences.length > 0
				? []
				: [
						...new Set(
							tree.inventory
								.filter(
									(occurrence) =>
										occurrence.value.kind === "pattern" &&
										typeof occurrence.value.prefix === "string" &&
										occurrence.value.prefix.startsWith(needle),
								)
								.map(
									(occurrence) =>
										`${(occurrence.value as { prefix?: string }).prefix ?? ""}*`,
								),
						),
					].slice(0, 5);
		// A lookup ships occurrences, never `roots`, so `tree-partial` here
		// describes a tree the caller did not ask for and cannot see — and reads as
		// a caveat on the inventory, which is the one thing that is always
		// complete.
		const full = withoutTreeShapeWarnings(tree.warnings);
		const warnings = planWarnings(session.warnings, full);
		return ok(
			{ occurrences },
			{
				attribute: tree.attribute,
				attributeSource: tree.attributeSource,
				playwrightConfig: configFileOf(workspace),
				// "That id is not rendered anywhere" is the single most misleading
				// answer this server can give when the attribute or the scope is
				// wrong, and this branch used to ship it with no warnings at all.
				warnings: warnings.shown,
				hint: withEnvironmentHint(
					full,
					lookupHint(
						needle,
						occurrences.length,
						catchAllSkipped,
						propOnly,
						families,
					),
				),
			},
			{
				// A lookup ignores `format`, `depth`, `followComponents`, `file` and
				// `component` - it answers from the scan-wide inventory - so the hint
				// the tree branch uses names five knobs this branch does not have.
				// Exactly what `coverageShrinkHint` was written to stop, one branch
				// over.
				shrinkHint:
					"A testId lookup has no per-call size control: it answers from the whole scan, and `format`, `depth` and the `file` / `component` scope do not narrow it. Look up a more specific id, or restart the server with a narrower --src-dir / --project-root.",
				onDelivered: warnings.delivered,
			},
		);
	}

	let entry = scope?.file;
	let entryComponent: string | undefined;
	let requested: ComponentInfo | undefined;
	let siblings: ComponentInfo[] = [];
	const scopeFile = scope?.file;
	if (args.component) {
		// The component inventory, not a tree. This used to build a whole depth-1
		// tree — scanning every JSX file for ids and running a walk — and read one
		// field off it, which is a second full pass over the sources before the
		// real tree below has even started.
		const components = Object.values(scannedComponents(workspace));
		const named = components.filter(
			(component) => component.name === args.component,
		);
		// A component name is only unique per file. Narrow by `file` when the
		// caller gave one; otherwise a name two files declare is ambiguous, and
		// answering with whichever was scanned first is a guess.
		const matches = scopeFile
			? named.filter((component) => isScannedFile(component.file, scopeFile))
			: named;
		if (matches.length === 0) {
			throw missingComponent(args.component, scopeFile, named, components);
		}
		if (matches.length > 1) {
			throw new ToolError(
				"ambiguous_component",
				`${matches.length} files declare a component named "${args.component}".`,
				{
					candidates: matches.map((component) => component.file).sort(),
					hint: "Re-call with `file` set to one of the candidates.",
				},
			);
		}
		const match = matches[0];
		entry = match.file;
		// The engine roots where it is told now, so the name resolved here is the
		// name the tree comes back rooted at — no re-derivation, no sibling
		// reconciliation, no chance of answering with a component nobody asked for.
		entryComponent = match.name;
		requested = match;
		siblings = components.filter(
			(component) =>
				component.file === match.file && component.name !== match.name,
		);
	}

	const tree = buildTestIdTree(workspace, {
		attribute: args.attribute,
		entry,
		entryComponent,
		maxDepth: depth,
		followComponents,
	});

	// The engine roots where it was told. The only way a named component still
	// fails to come back is the engine refusing it outright, and its reason is
	// more specific than anything this layer could re-derive.
	//
	// `file` alone counts as being told. `resolveEntryFile` has already proved
	// the path names a scanned source, so reaching here means the file exists
	// and declares nothing the walk recognises — a React *class* component, say.
	// The engine's answer to that is a flat inventory of the entire scan, which
	// through this tool reads as "your scope was ignored, here is the whole
	// repository": `ok: true`, one `info` note, and on a large app 186 KB of
	// occurrences where a component's tree was asked for. Refusing is the same
	// rule `resolveEntryFile` applies one step earlier, at the step that can
	// finally see what the file contains.
	if ((requested || scope) && tree.fidelity === "flat") {
		const named = requested
			? `"${requested.name}" could not be rooted in "${requested.file}".`
			: `"${scope?.file}" declares no component this walk can root at.`;
		throw new ToolError("incomplete_tree", tree.fidelityReason ?? named, {
			candidates: siblings.map((one) => one.name).sort(),
			hint: requested
				? `Pass testId to find where "${requested.name}" is rendered, or request one of the other components in that file.`
				: "Only function components are walked; a class component is not one. Pass `testId` to find where a known id is rendered, or `component` to root at a function component elsewhere.",
		});
	}

	const roots = tree.roots;
	const gap = traversalGap(roots, tree.truncated === true);
	const warnings = planWarnings(session.warnings, tree.warnings);
	const blind = blindScan(tree.warnings, roots, gap);
	const meta: Record<string, unknown> = {
		attribute: tree.attribute,
		attributeSource: tree.attributeSource,
		playwrightConfig: configFileOf(workspace),
		note: scope?.note,
		fidelity: tree.fidelity,
		fidelityReason: tree.fidelityReason,
		truncated: tree.truncated,
		scanned: tree.stats.files,
		suppressed: blind,
		// Only on a holed tree: on a complete one every id in a walked file is in
		// the tree by construction, and an empty key would be noise on every call.
		idsNotPlaced: gap ? idsNotPlaced(roots, tree.inventory) : undefined,
		warnings: warnings.shown,
		// A partial tree is the normal answer for any real app, so the useful
		// thing is not the word but what to do about it. "Absent from this tree"
		// must never be read as "not rendered" while a gap is open.
		hint: withEnvironmentHint(
			tree.warnings,
			gap ? gapHint(gap, depth, followComponents) : undefined,
		),
	};

	const shrink = {
		shrinkHint: `Re-call with format:"outline", a lower depth (this call used ${depth}), or scope the walk with \`file\` or \`component\`.`,
		onDelivered: warnings.delivered,
	};

	// Nothing to read, so nothing to send. The nodes are real, but every one of
	// them is id-less because the attribute this run searched for is not the one
	// the sources write - the analysis has already proven the payload carries no
	// answer, and shipping it costs 11 KB to say so. The warning and the hint,
	// which are the actual answer, ship as always.
	if (blind) {
		return ok(
			{ fidelity: tree.fidelity, roots: [], stats: subtreeStats([]) },
			meta,
			shrink,
		);
	}

	if (args.format === "outline") {
		return ok(renderTestIdOutline(tree), meta, shrink);
	}

	if (tree.fidelity === "flat") {
		return ok({ fidelity: "flat", inventory: tree.inventory }, meta, shrink);
	}

	// Counted over `roots`, not over the scan: those are two different shapes
	// whenever the tree is rooted at one component of many, and stats describing
	// something the caller cannot see are worse than no stats. Scan-wide numbers
	// live in `meta.scanned`.
	return ok(
		{ fidelity: tree.fidelity, roots, stats: subtreeStats(roots) },
		meta,
		shrink,
	);
}
