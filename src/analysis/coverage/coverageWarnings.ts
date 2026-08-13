import { info, warn } from "../diagnostics";
import type { buildTestIdTree } from "../tsx/tree";
import type { Diagnostic, TestIdTree } from "../types";
import type { InventoryPartition } from "./inventory";

/**
 * What a coverage run says about its own scope and evidence, as distinct
 * from what it counted.
 *
 * Split out of `mapCoverage.ts`, which keeps the pipeline that assembles a
 * report from these parts.
 */

/**
 * Whether this run knows its view of the UI is partial.
 *
 * One definition, read twice: it gates the `ui-scope-incomplete` warning and it
 * stamps every dead selector. A per-entry flag that could disagree with the
 * warning it points the reader at would be worse than no flag at all.
 */
export function uiScopeIncomplete(uiTree: TestIdTree): boolean {
	return uiTree.stats.externalComponentTags > 0;
}

interface WarningInputs {
	attribute: { attribute: string; source: string };
	partition: InventoryPartition;
	matchable: number;
	uiTree: ReturnType<typeof buildTestIdTree>;
	assumeForwarded: boolean;
	assumedGroups: number;
	unprovenSelectors: number;
	/** Selectors this run could not judge at all, for want of any UI evidence. */
	unverifiableSelectors: number;
	catchAllSelectors: number;
	testIdSelectors: number;
	deadCount: number;
	includeRawLocators: boolean;
	poInclude: string[] | undefined;
	/** `poInclude` narrowed the page-object side while the UI side stayed whole. */
	scopedToPageObjects: boolean;
	coveredUi: number;
	uncovered: number;
}

/** Share of test-id selectors landing on unproven props that is worth naming. */
const WIDESPREAD_SHARE = 0.25;
const WIDESPREAD_COUNT = 3;

/**
 * Everything the numbers alone cannot say.
 *
 * The rule for every message here: name the count, name a place to look, and
 * name the remedy in terms of the analysis rather than of any one front end's
 * flags. The engine is consumed by the MCP server, by tests and by anything
 * embedding it later, so a message that spells `--src-dir` is wrong advice in
 * two of those three — the MCP layer translates into flags where it can.
 */
export function coverageWarnings(inputs: WarningInputs): Diagnostic[] {
	const out: Diagnostic[] = [];
	const { partition } = inputs;
	const propOccurrences = partition.prop.reduce(
		(total, ui) => total + ui.occurrences.length,
		0,
	);

	if (inputs.matchable === 0) {
		const total = inputs.uiTree.stats.occurrences;
		out.push(
			warn(
				"no-matchable-testids",
				`No rendered test id could be used as a coverage denominator: 0 of ${total} occurrence(s) across ${inputs.uiTree.stats.files} scanned UI file(s) are matchable ` +
					`(${partition.dynamic.length} built at runtime, ${propOccurrences} written as an unproven component prop, ${partition.catchAll.length} matching every id). ` +
					`The attribute read was "${inputs.attribute.attribute}" (from ${inputs.attribute.source}). ` +
					"Either the components write a different attribute than the one resolved, or the scanned sources do not contain the UI at all. " +
					"Re-run with the attribute the components actually write, or with the application sources in scope. Until then the coverage ratio is null rather than a score" +
					(inputs.unverifiableSelectors > 0
						? `, and the ${inputs.unverifiableSelectors} selector(s) this run could not judge are in unknownSelectors with reason "no-ui-evidence" rather than in deadSelectors — with nothing to compare against, none of them was tested.`
						: "."),
				undefined,
				{
					attribute: inputs.attribute.attribute,
					attributeSource: inputs.attribute.source,
					occurrences: total,
					files: inputs.uiTree.stats.files,
				},
			),
		);
	}

	if (inputs.scopedToPageObjects && inputs.matchable > 0) {
		out.push(
			warn(
				"coverage-scope-narrowed",
				`The page-object side of this report is scoped to ${inputs.poInclude?.length ?? 0} file(s) (${(inputs.poInclude ?? []).join(", ")}) while the UI side is every scanned source, so summary.coverage is null rather than ${inputs.coveredUi}/${inputs.matchable}: the two halves answer different questions and dividing them scores a single page object against the whole application. ` +
					`matched, deadSelectors, nonTestIdSelectors and unknownSelectors are exact for the scoped selectors. uncoveredTestIds (${inputs.uncovered}) and matchableUiTestIds (${inputs.matchable}) stay project-wide, so most entries there are ids other page objects cover. ` +
					"Re-run without the scope for a ratio that has a denominator.",
				undefined,
				{
					files: inputs.poInclude?.length ?? 0,
					covered: inputs.coveredUi,
					matchable: inputs.matchable,
				},
			),
		);
	}

	if (partition.catchAll.length > 0) {
		const [sample] = partition.catchAll;
		const distinct = new Set(
			partition.catchAll.map((occurrence) =>
				occurrence.value.kind === "pattern"
					? occurrence.value.regex.source
					: "",
			),
		);
		out.push(
			warn(
				"unanchored-testid-pattern",
				`${partition.catchAll.length} test id expression(s) in ${distinct.size} distinct pattern(s) match every possible id (for example \`${sample.value.raw}\` at ${sample.file}:${sample.loc.line}). ` +
					"They are excluded from matching: counted, each would have made every selector in the project look covered and emptied the dead-selector list. " +
					"Give those elements a literal prefix to make them matchable.",
				sample.loc,
				{ count: partition.catchAll.length, patterns: distinct.size },
			),
		);
	}

	if (inputs.catchAllSelectors > 0) {
		out.push(
			warn(
				"unanchored-testid-pattern",
				`${inputs.catchAllSelectors} selector(s) declare a pattern that matches every id, so they are reported as unknown rather than credited with covering everything.`,
				undefined,
				{ selectors: inputs.catchAllSelectors },
			),
		);
	}

	if (partition.prop.length > 0) {
		out.push(
			info(
				"testid-forwarding-unproven",
				`${partition.prop.length} test id(s) are written as a prop on a component tag and no forwarding to a host element could be proven; they are listed under unknownTestIds rather than counted as rendered.`,
			),
		);
	}

	if (inputs.assumeForwarded) {
		out.push(
			warn(
				"forwarding-assumed",
				`Forwarding was assumed rather than proven: ${inputs.assumedGroups} test id(s) written only as a component prop are counted as rendered. Every affected match carries forwarding: "assumed" and every affected id is flagged; re-run without the assumption for the proven-only picture.`,
				undefined,
				{ assumed: inputs.assumedGroups },
			),
		);
	}

	if (
		!inputs.assumeForwarded &&
		inputs.unprovenSelectors > 0 &&
		(inputs.unprovenSelectors >= WIDESPREAD_COUNT ||
			(inputs.testIdSelectors > 0 &&
				inputs.unprovenSelectors / inputs.testIdSelectors >= WIDESPREAD_SHARE))
	) {
		out.push(
			info(
				"forwarding-unproven-widespread",
				`${inputs.unprovenSelectors} of ${inputs.testIdSelectors} test-id selector(s) match only ids written as component props. That is the signature of a component library that forwards props as a matter of course; if this one does, re-run assuming forwarding to see them as matches.`,
				undefined,
				{
					unproven: inputs.unprovenSelectors,
					selectors: inputs.testIdSelectors,
				},
			),
		);
	}

	if (uiScopeIncomplete(inputs.uiTree)) {
		const modules = inputs.uiTree.externalModules;
		// `sourceRoot` rides in `data` as well as in the prose: a front end that
		// translates advice into its own flags needs the directory as a value, not
		// as a substring of an English sentence.
		const data = {
			tags: inputs.uiTree.stats.externalComponentTags,
			// The real total, not `modules.length` — that array is capped at ten for
			// display, so reading its length reported "10" for every repository with
			// ten or more and told a reader on a 44-module app their blind spot was
			// a quarter of its actual size.
			modules: inputs.uiTree.externalModuleCount,
			...(inputs.uiTree.externalModuleRoot
				? { sourceRoot: inputs.uiTree.externalModuleRoot }
				: {}),
		};
		const message = scopeMessage({
			tags: inputs.uiTree.stats.externalComponentTags,
			modules,
			moduleCount: inputs.uiTree.externalModuleCount,
			linkedModules: inputs.uiTree.linkedExternalModules,
			linkedCount: inputs.uiTree.linkedExternalModuleCount,
			sourceRoot: inputs.uiTree.externalModuleRoot,
			deadCount: inputs.deadCount,
		});
		out.push(
			inputs.deadCount > 0
				? warn("ui-scope-incomplete", message, undefined, data)
				: info("ui-scope-incomplete", message, undefined, data),
		);
	}

	if (!inputs.includeRawLocators) {
		out.push(
			info(
				"raw-locators-disabled",
				"Direct locator calls (getByTestId, getItemByTestId, filterByItemTestId, filterByHasTestId) were not scanned; an uncovered test id does not necessarily mean it is untested. Re-run with includeRawLocators: true to include them.",
			),
		);
	}

	return out;
}

export interface ScopeEvidence {
	tags: number;
	/** Display sample of the specifiers, capped. */
	modules: string[];
	/** How many there really are. Never `modules.length`. */
	moduleCount: number;
	/** Display sample of those with sources in this repository, capped. */
	linkedModules: string[];
	linkedCount: number;
	sourceRoot?: string;
	deadCount: number;
}

/**
 * Exported for tests: the linked/installed split cannot be reached through
 * `buildCoverageReport` from an in-memory fixture, because deciding a module is
 * *linked* means resolving a real `node_modules` symlink on disk. Taking the
 * evidence as a value rather than reaching into `WarningInputs` also keeps this
 * function honest about the handful of fields it actually reads.
 */
export function scopeMessage(evidence: ScopeEvidence): string {
	const {
		modules,
		moduleCount: total,
		linkedModules: linked,
		linkedCount,
		sourceRoot: root,
		deadCount,
	} = evidence;
	// Say when the list is a sample. `modules` is capped at ten; presenting it
	// as the whole set alongside a larger count would read as a contradiction.
	const named =
		modules.length === 0
			? "unresolved modules"
			: modules.length < total
				? `first ${modules.length} by name: ${modules.join(", ")}`
				: modules.join(", ");
	// Only when there are entries to have been stamped: promising a flag on an
	// empty list sends a reader looking for something that is not there.
	const flagged =
		deadCount > 0
			? ` All ${deadCount} entr${deadCount === 1 ? "y" : "ies"} in deadSelectors carry scopeIncomplete for this reason — read them as unverified. Triage by nearestTestIds: a non-empty list is the actionable case, because an id one edit away is what a rename leaves behind. An empty list here more often means the id is rendered inside one of the modules above than that the selector is wrong.`
			: "";
	// Only the modules that actually resolved to in-repo source may be said to
	// have any: `root` is the common ancestor of *those*, and the sentence used
	// to generalise it to every module named above — asserting that
	// `@sentry/react` ships its sources from this repository. The rest are
	// installed packages, and the two halves take different advice, so both are
	// stated.
	const linkedNames =
		linked.length < linkedCount
			? `${linked.join(", ")}, and ${linkedCount - linked.length} more`
			: linked.join(", ");
	const rest =
		linkedCount < total
			? ` The other ${total - linkedCount} resolve to installed packages or do not resolve at all; nothing in scope reaches those, and the ids inside them can only be confirmed from the packages themselves.`
			: "";
	const remedy = root
		? `${linkedCount} of them (${linkedNames}) resolve through a node_modules link onto sources in this repository, at or under "${root}" — re-run with the analysis rooted at "${root}" to bring those into scope. Widening the scanned directories cannot: a directory outside the root is dropped before anything is counted.${rest}`
		: "They resolve to installed packages, or do not resolve at all, so no scanning scope reaches their sources; the ids inside them can only be confirmed from the packages themselves.";
	return (
		`${evidence.tags} component tag(s) come from ${total} module(s) outside the scanned sources (${named}). ` +
		"Test ids rendered inside them are invisible here, so an id may exist without appearing in this report and a selector for one reads as dead. " +
		remedy +
		flagged
	);
}
