import type * as z from "zod";
import {
	buildCoverageReport,
	type CoverageBucket,
	discoverPageObjects,
	nearestFiles,
	nearestNames,
	type Workspace,
} from "../../analysis";
import { hintForSuggestions, ToolError } from "../errors";
import {
	type CoverageHandles,
	HANDLE_LIFETIME_TEXT,
	handleFailureMessage,
} from "../handles";
import type { McpServerOptions } from "../options";
import {
	BUCKET_ORDER,
	type BucketSlice,
	coverageResult,
	coverageShrinkHint,
	degradeHint,
	pagingHint,
	selectedBuckets,
} from "../present/coverage";
import { foldFile } from "../present/paths";
import { MAX_ERROR_LIST } from "../respond";
import type { mapCoverageInput, queryCoverageInput } from "../schemas";
import { relativizeFile } from "../target";
import {
	configFileOf,
	type ToolSession,
	withEnvironmentHint,
} from "../toolContext";
import { planWarnings } from "../warnings";

/**
 * Coverage, and paging back into a report already computed.
 */

export function handleMapCoverage(
	workspace: Workspace,
	args: z.infer<typeof mapCoverageInput>,
	options: Pick<McpServerOptions, "assumeForwarded"> &
		ToolSession & {
			handles?: CoverageHandles;
		} = {},
) {
	let poInclude: string[] | undefined;
	let alsoIncluded: string[] | undefined;
	let note: string | undefined;
	if (args.file) {
		// Scoping is a path glob, so an unmatched `file` selects zero page objects
		// and the report comes back "successful" with every rendered id uncovered —
		// which reads as a suite that tests nothing and invites edits to page
		// objects that were never in scope. Resolve it against the index first, the
		// way the `class` branch does. Controls count: they are only left out of
		// `list_page_objects`, not out of the coverage scan.
		//
		// The plain index is consulted first because it is the one every other
		// handler already built. Widening to controls is a *second* full discovery
		// under a different memo key — measured at 770 ms on a 4,924-file
		// repository — and only a file that declares nothing but controls needs it.
		// The answer is the same either way: the controls index is a superset, so a
		// file found in the plain one is found in both, and a file in neither
		// produces the same error from the same widened candidate list.
		const resolved = relativizeFile(workspace, args.file);
		note = resolved.note;
		const wanted = foldFile(resolved.file);
		const filesOf = (includeControls: boolean): string[] => [
			...new Set(
				discoverPageObjects(workspace, { includeControls }).pageObjects.map(
					(item) => item.file,
				),
			),
		];
		let files = filesOf(false);
		let match = files.find((file) => foldFile(file) === wanted);
		if (!match) {
			files = filesOf(true);
			match = files.find((file) => foldFile(file) === wanted);
		}
		if (!match) {
			const suggestions = nearestFiles(resolved.file, files);
			throw new ToolError(
				"file_not_found",
				`No page object is declared in "${args.file}".`,
				{
					suggestions,
					hint: hintForSuggestions(suggestions, {
						some: "Use one of the suggested paths, or pass `class` and let the server find the file; list_page_objects reports the file of every page object.",
						none: "No page-object file resembles that path - it may be a UI source rather than a page object, and this tool scopes by page object. Pass `class`, or call list_page_objects to see every page object and its file.",
					}),
				},
			);
		}
		// The discovered spelling, not the caller's: the include glob is matched
		// case-sensitively against workspace-relative paths.
		poInclude = [match];
	} else if (args.class) {
		// Widened on a miss, exactly as the `file` branch above does. The default
		// index filters out factory-only controls, and a control's class name is
		// precisely what a parent's selector tree hands the caller — so asking for
		// its coverage by the name the tree just showed you answered
		// `class_not_found` and recommended `list_page_objects`, which by design
		// never lists it. The same selectors were auditable by `file`.
		let index = discoverPageObjects(workspace);
		let matches = index.pageObjects.filter(
			(item) => item.className === args.class,
		);
		if (matches.length === 0) {
			const widened = discoverPageObjects(workspace, { includeControls: true });
			const found = widened.pageObjects.filter(
				(item) => item.className === args.class,
			);
			if (found.length > 0) {
				index = widened;
				matches = found;
			}
		}
		if (matches.length === 0) {
			const wanted = args.class ?? "";
			const names = index.pageObjects.map((item) => item.className);
			// Substring then edit distance, in `nearestNames`: the two passes used
			// to be spelled out here and nowhere else, which is how the engine's own
			// class lookup ended up with only one of them.
			const suggestions = nearestNames(wanted, names, MAX_ERROR_LIST);
			throw new ToolError(
				"class_not_found",
				`No page object named "${wanted}" was found.`,
				{
					suggestions,
					hint: "Call list_page_objects to see every page object.",
				},
			);
		}
		if (matches.length > 1) {
			throw new ToolError(
				"ambiguous_class",
				`${matches.length} classes named "${args.class}".`,
				{
					candidates: matches.map((item) => item.file),
					hint: "Re-call with `file` set to one of the candidates.",
				},
			);
		}
		poInclude = [matches[0].file];
		// Scoping happens by path, so page objects sharing the file are analyzed
		// too and do count towards the totals. Say so rather than imply otherwise.
		const shared = index.pageObjects
			.filter(
				(item) =>
					item.file === matches[0].file &&
					item.className !== matches[0].className,
			)
			.map((item) => item.className);
		if (shared.length > 0) {
			alsoIncluded = shared;
		}
	}

	const assumeForwarded =
		args.assumeForwarded ?? options.assumeForwarded ?? false;
	const report = buildCoverageReport(workspace, {
		attribute: args.attribute,
		poInclude,
		includeRawLocators: args.includeRawLocators,
		assumeForwarded,
	});

	// A scoped call narrows the selectors and cannot narrow the ids they are
	// compared against, so `uncoveredTestIds` is still every id in the
	// application - measured at 61,788 bytes on a real app, to answer a question
	// about one class. The report says so in a warning, but the caller pays the
	// whole list to read it. So the list is off by default exactly when it is
	// least likely to be what was meant, and the caller can still ask.
	const scoped = poInclude !== undefined;
	const includeUnused = args.includeUnused ?? !scoped;
	const { buckets, ignored } = selectedBuckets(
		args.buckets as CoverageBucket[] | undefined,
		includeUnused,
		args.includeUnused !== undefined,
	);
	const unusedDefaultedOff =
		scoped && args.includeUnused === undefined && args.buckets === undefined;
	// One `offset` across every returned bucket, rather than one per bucket: the
	// way an agent actually pages is to ask for a single bucket and walk it
	// (`query_coverage`, or `buckets:["unknownTestIds"]`), and a map of offsets
	// keyed by bucket is a second thing to get wrong for a case nobody drives.
	// The totals are in `summary` for all six buckets whatever this call
	// returned, so `meta` only has to say what is missing from *here*: how many
	// came back, and where the next page starts.
	const offset = args.offset;
	const slices: BucketSlice[] = [];
	let largest = 0;
	for (const bucket of BUCKET_ORDER) {
		if (!buckets.has(bucket)) {
			continue;
		}
		const list: unknown[] = report[bucket];
		largest = Math.max(largest, list.length);
		slices.push({
			name: bucket,
			total: list.length,
			page: list.slice(offset, offset + args.limit),
		});
	}

	const attributeSource = args.attribute
		? "param"
		: workspace.testIdAttribute().source;
	// Minted on every call, including `buckets: []` — summary-first then page the
	// one bucket that matters is the workflow this is for, and the summary-only
	// call is where that walk starts.
	const coverageId = options.handles?.create(workspace, {
		report,
		attributeSource,
		assumeForwarded,
		alsoIncluded,
		note,
	});

	// Once, not inside `buildMeta`: that runs up to three times while the payload
	// is measured against the cap, and a plan that abbreviated more on each pass
	// would make the measured size disagree with the sent one.
	const warnings = planWarnings(options.warnings, report.warnings);

	return coverageResult({
		// `summary` and `scope` always ship: they are the totals every capped list
		// is read against, and a bucket selection that hid them would turn a
		// shorter response into an unreadable one.
		base: { summary: report.summary, scope: report.scope },
		slices,
		offset,
		onDelivered: warnings.delivered,
		shrinkHint: coverageShrinkHint(
			args.buckets as CoverageBucket[] | undefined,
			args.limit,
			coverageId,
		),
		buildMeta: (paging) => ({
			attribute: report.attribute,
			attributeSource,
			playwrightConfig: configFileOf(workspace),
			// In `meta`, next to `offset` / `shown` / `nextOffset`: the handle is a
			// paging cursor, and every other paging field already lives here. An
			// agent reading `meta.nextOffset` needs the id it belongs to in the same
			// place, not one level away in the report body.
			coverageId,
			alsoIncluded,
			note,
			assumeForwarded: assumeForwarded ? true : undefined,
			ignored,
			offset: offset > 0 ? offset : undefined,
			shown: Object.keys(paging.shown).length > 0 ? paging.shown : undefined,
			nextOffset:
				Object.keys(paging.nextOffset).length > 0
					? paging.nextOffset
					: undefined,
			truncatedBuckets: paging.truncatedBuckets,
			warnings: warnings.shown,
			truncated: paging.truncated,
			// A coverage score computed against the wrong attribute used to read as
			// a healthy `1` (zero of zero ids covered) — the one number in this
			// payload nobody double-checks. It gets the loudest treatment.
			hint: withEnvironmentHint(
				report.warnings,
				degradeHint(paging, coverageId) ??
					pagingHint(offset, slices.length, paging.returned, largest) ??
					(unusedDefaultedOff
						? `uncoveredTestIds was left out: this call is scoped to a page object, and that list is project-wide whatever the scope, so it would mostly be ids other page objects cover (summary.uncoveredTestIds still counts them). Ask for it with buckets:["uncoveredTestIds"] or includeUnused:true.`
						: undefined),
			),
		}),
	});
}

/**
 * Pages one bucket of a report a previous `map_coverage` call already built.
 *
 * The handle is what makes the walk checkable. `map_coverage` with
 * `{buckets:["x"], offset:N}` returns the same entries just as cheaply — the
 * report is memoized per epoch — but it re-derives the report each time, so an
 * edit between two pages silently renumbers the list underneath the offsets and
 * the response says nothing. Here the same edit invalidates the handle and the
 * caller is told, which is the difference between a paging walk that can be
 * trusted and one that merely usually works.
 */
export function handleQueryCoverage(
	workspace: Workspace,
	args: z.infer<typeof queryCoverageInput>,
	handles: CoverageHandles,
	session: ToolSession = {},
) {
	const lookup = handles.resolve(args.coverageId, workspace);
	if (!lookup.ok) {
		throw new ToolError("expired_handle", handleFailureMessage(lookup.reason), {
			hint: `Re-call map_coverage with the arguments that produced this id (its scope is not recoverable from the id itself) and use the new meta.coverageId. ${HANDLE_LIFETIME_TEXT}`,
		});
	}
	const { report, attributeSource, assumeForwarded, alsoIncluded, note } =
		lookup.snapshot;

	const list: unknown[] = report[args.bucket];
	const slice: BucketSlice = {
		name: args.bucket,
		total: list.length,
		page: list.slice(args.offset, args.offset + args.limit),
	};

	const warnings = planWarnings(session.warnings, report.warnings);

	return coverageResult({
		// `summary` on every page is deliberate - it is what a capped list is read
		// against. `scope` is not: it is byte-identical on every page of the same
		// snapshot, and the handle guarantees the snapshot has not moved, so past
		// the first page it is ~2 KB of prose the reader already has from the call
		// that minted the id. The tool description says where to find it.
		base:
			args.offset > 0
				? { summary: report.summary }
				: { summary: report.summary, scope: report.scope },
		slices: [slice],
		offset: args.offset,
		onDelivered: warnings.delivered,
		shrinkHint: `Re-call with a lower \`limit\` (this call used ${args.limit}), then page the rest with \`offset\`. map_coverage with buckets: [] returns the totals alone.`,
		buildMeta: (paging) => ({
			attribute: report.attribute,
			attributeSource,
			playwrightConfig: configFileOf(workspace),
			// Echoed so a page is a complete instruction for the next one: the id
			// stays valid for as long as the sources do not change.
			coverageId: args.coverageId,
			bucket: args.bucket,
			alsoIncluded,
			note,
			assumeForwarded,
			offset: args.offset > 0 ? args.offset : undefined,
			// One bucket, so one number rather than the record `map_coverage`
			// returns: `meta.nextOffset` copies straight into the next call's
			// `offset`, which is what makes the walk hard to get wrong.
			shown: paging.shown[args.bucket],
			nextOffset: paging.nextOffset[args.bucket],
			truncatedBuckets: paging.truncatedBuckets,
			warnings: warnings.shown,
			truncated: paging.truncated,
			hint: withEnvironmentHint(
				report.warnings,
				degradeHint(paging, args.coverageId) ??
					pagingHint(args.offset, 1, paging.returned, list.length),
			),
		}),
	});
}
