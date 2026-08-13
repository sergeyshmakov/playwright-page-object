import { Node, SyntaxKind } from "ts-morph";
import { dedupeDiagnostics, info, warn } from "../diagnostics";
import { discoverInternal } from "../page-objects/discover";
import { readExpressionValue } from "../tsx/scanTestIds";
import { buildTestIdTree } from "../tsx/tree";
import type {
	CoverageReport,
	Diagnostic,
	SelectorInfo,
	SelectorUsage,
	SourceLoc,
	TestIdOccurrence,
	TestIdTree,
	UiTestId,
	UnknownSelectorEvidence,
	UnknownTestId,
} from "../types";
import { literalPrefixOf, parseRegexLiteral } from "../util/literal";
import { keyFold, matchesAnyGlob } from "../util/paths";
import type { Workspace } from "../workspace";
import {
	type ClassifySides,
	classifySelector,
	indexSide,
	labelOf,
	type Match,
} from "./classify";
import { coverageWarnings, uiScopeIncomplete } from "./coverageWarnings";
import { type InventoryPartition, partitionInventory } from "./inventory";
import { isCatchAllPattern } from "./match";
import { nearestIds } from "./suggest";
import { collectSelectorUsages, sweepRawLocators } from "./usages";

export interface CoverageOptions {
	attribute?: string;
	/** Also sweep the sources for direct `getByTestId(...)`-family calls. */
	includeRawLocators?: boolean;
	uiInclude?: string[];
	poInclude?: string[];
	/**
	 * Count a test id written on a component tag as rendered.
	 *
	 * The honest default is not to: a prop only reaches the DOM if the component
	 * forwards it. But a codebase whose design system forwards props as a rule
	 * knows that about itself, and for those the unproven bucket is noise. Every
	 * id and every match the flag changes is labelled, so the assumption is never
	 * invisible in the output.
	 */
	assumeForwarded?: boolean;
}

/** Evidence entries are for reading, not for exhaustive enumeration. */
const MAX_EVIDENCE_IDS = 5;

function suggestionFor(ui: UiTestId): string {
	if (ui.id !== null) {
		return `@Selector(${JSON.stringify(ui.id)})`;
	}
	if (ui.prefix) {
		return `@ListSelector(${JSON.stringify(ui.prefix)})`;
	}
	return `@ListSelector(${JSON.stringify(ui.patternSource ?? "")})`;
}

function labelsOf(matches: Match[]): string[] {
	return [...new Set(matches.map((match) => labelOf(match.ui)))].slice(
		0,
		MAX_EVIDENCE_IDS,
	);
}

/**
 * Cross-references UI test ids against page-object selectors.
 *
 * Role, text, label, placeholder, alt-text and title selectors go to their own
 * bucket and are *never* counted as dead. `@SelectorByRole("button", { name:
 * "Apply" })` is a first-class selector; flagging it would train people to
 * ignore the report.
 */
/**
 * Cache identity for one report. Same rule as the tree: engine inputs only,
 * caller's raw `attribute` rather than the resolved one, and nothing about how
 * the handler intends to page or slice the buckets afterwards.
 */
function coverageKey(options: CoverageOptions): string {
	return `coverage::${JSON.stringify({
		attribute: options.attribute ?? null,
		includeRawLocators: options.includeRawLocators === true,
		uiInclude: options.uiInclude ?? null,
		poInclude: options.poInclude ?? null,
		assumeForwarded: options.assumeForwarded === true,
	})}`;
}

/**
 * Builds the coverage report.
 *
 * Memoized per epoch; the result is a wire shape, and callers must read it
 * without writing to it. `buckets`, `limit` and `offset` are the handler's
 * business and deliberately absent from the key: they slice this report rather
 * than change it.
 */
export function buildCoverageReport(
	ws: Workspace,
	options: CoverageOptions = {},
): CoverageReport {
	return ws.memo(coverageKey(options), [], () =>
		computeCoverageReport(ws, options),
	);
}

function computeCoverageReport(
	ws: Workspace,
	options: CoverageOptions,
): CoverageReport {
	const attribute = options.attribute
		? { attribute: options.attribute, source: "param" as const }
		: ws.testIdAttribute();
	const warnings: Diagnostic[] = [
		...ws.environmentWarnings(attribute.attribute),
	];

	const uiTree = buildTestIdTree(ws, {
		attribute: attribute.attribute,
		include: options.uiInclude,
	});
	// Every warning the UI scan raised except the one that describes a shape this
	// report does not ship. `tree-partial` is a statement about `roots` — its own
	// text says ids beyond the cut are "missing from roots but present in
	// inventory" — and coverage returns no roots at all: it is computed from the
	// inventory, which is complete whatever the walk did. Repeating it here told a
	// reader their coverage numbers were partial when nothing about them was.
	warnings.push(
		...uiTree.warnings.filter((warning) => warning.code !== "tree-partial"),
	);

	const discovery = discoverInternal(ws, { include: options.poInclude });
	warnings.push(...discovery.index.warnings);

	const assumeForwarded = options.assumeForwarded === true;
	const partition = partitionInventory(uiTree.inventory, assumeForwarded);
	// Kept apart from the raw sweep below: `scope.pageObjectFilesScanned` counts
	// these and only these.
	const pageObjectUsages = collectSelectorUsages(discovery);
	const usages = [
		...pageObjectUsages,
		// Deliberately unscoped, even when `poInclude` is set. `poInclude` narrows
		// *whose selectors are being audited*; it does not narrow what counts as
		// evidence that an id is used. Scoping the sweep to the page-object file
		// made `includeRawLocators` nearly inert on a scoped call - a page-object
		// file rarely contains `page.getByTestId` - and reported an id as
		// uncovered while a spec three directories away selected it by name.
		...(options.includeRawLocators ? sweepRawLocators(ws, undefined) : []),
	];

	const matched: CoverageReport["matched"] = [];
	const nonTestIdSelectors: CoverageReport["nonTestIdSelectors"] = [];
	const unknownSelectors: CoverageReport["unknownSelectors"] = [];
	const deadSelectors: CoverageReport["deadSelectors"] = [];
	const testIdUsages: SelectorUsage[] = [];
	let catchAllSelectors = 0;

	for (const usage of usages) {
		if (usage.kind === "custom" || usage.dynamic) {
			unknownSelectors.push({
				defId: usage.defId,
				memberPath: usage.memberPath,
				loc: usage.loc,
				reason: usage.reason ?? "custom-selector",
				raw: usage.text,
				origin: usage.origin,
			});
			continue;
		}
		if (usage.kind === "testId" || usage.kind === "testIdPattern") {
			// `@ListSelector("")` compiles to `new RegExp("")`, which matches every
			// id in the repository. Matching it would credit the selector with
			// covering the whole app; the honest answer is that it proves nothing.
			if (usage.pattern && isCatchAllPattern(usage.pattern.source)) {
				catchAllSelectors += 1;
				unknownSelectors.push({
					defId: usage.defId,
					memberPath: usage.memberPath,
					loc: usage.loc,
					reason: "unanchored-pattern",
					raw: usage.text,
					origin: usage.origin,
				});
				continue;
			}
			testIdUsages.push(usage);
			continue;
		}
		if (usage.kind === "self") {
			continue;
		}
		nonTestIdSelectors.push({
			kind: usage.kind,
			defId: usage.defId,
			memberPath: usage.memberPath,
			loc: usage.loc,
			text: usage.text,
		});
	}

	const renderedIndex = indexSide(partition.rendered);
	const propIndex = indexSide(partition.prop);
	const sides: ClassifySides = {
		renderedById: renderedIndex.byId,
		renderedStatic: renderedIndex.statics,
		renderedPatterns: renderedIndex.patterns,
		propById: propIndex.byId,
		propStatic: propIndex.statics,
		propPatterns: propIndex.patterns,
		unknownRaw: partition.dynamic,
		// Every occurrence lands in exactly one of the partition's four buckets,
		// so an empty inventory is precisely "the scan found no test id at all".
		uiEvidence: uiTree.inventory.length > 0,
	};

	const coveredUi = new Set<UiTestId>();
	const speculativeCredit = new Map<UiTestId, string[]>();
	let unprovenSelectors = 0;
	let unverifiableSelectors = 0;
	// A property of the run, not of any one selector, so it is read once.
	const scopeIncomplete = uiScopeIncomplete(uiTree);

	for (const usage of testIdUsages) {
		const selector = { testId: usage.testId, pattern: usage.pattern };
		const classification = classifySelector(selector, sides);

		if (classification.verdict === "matched") {
			const unproven = alsoUnproven(classification.alsoUnproven);
			for (const match of classification.matches) {
				coveredUi.add(match.ui);
				matched.push({
					selector: {
						defId: usage.defId,
						memberPath: usage.memberPath,
						loc: usage.loc,
						kind: usage.kind,
						text: usage.text,
						origin: usage.origin,
					},
					ui: {
						id: match.ui.id,
						patternSource: match.ui.patternSource,
						occurrences: match.ui.occurrences.map(
							(occurrence) => occurrence.loc,
						),
					},
					confidence: match.outcome.confidence,
					...(match.outcome.probe ? { probe: match.outcome.probe } : {}),
					...(match.ui.assumed ? { forwarding: "assumed" as const } : {}),
					...unproven,
				});
			}
			continue;
		}

		if (classification.verdict === "forwarding-unproven") {
			unprovenSelectors += 1;
			const evidence: UnknownSelectorEvidence = {
				testIds: labelsOf(classification.matches),
			};
			const witness = classification.matches[0]?.ui.occurrences[0];
			if (witness) {
				evidence.loc = witness.loc;
			}
			if (classification.outranked.length > 0) {
				evidence.alsoMatchesRendered = labelsOf(classification.outranked);
				// The list is trimmed to `MAX_EVIDENCE_IDS`, and its own type doc used
				// to promise nothing was dropped. A `@ListSelector` prefix over forty
				// rendered ids reported five and said so nowhere.
				const distinct = new Set(
					classification.outranked.map((match) => labelOf(match.ui)),
				).size;
				if (distinct > evidence.alsoMatchesRendered.length) {
					evidence.alsoMatchesRenderedTotal = distinct;
				}
				for (const match of classification.outranked) {
					const credited = speculativeCredit.get(match.ui);
					if (credited) {
						credited.push(usage.memberPath);
					} else {
						speculativeCredit.set(match.ui, [usage.memberPath]);
					}
				}
			}
			unknownSelectors.push({
				defId: usage.defId,
				memberPath: usage.memberPath,
				loc: usage.loc,
				reason: "forwarding-unproven",
				raw: usage.text,
				origin: usage.origin,
				evidence,
			});
			continue;
		}

		// Nothing on the UI side to compare against, so this selector was never
		// judged. It is unverifiable, not dead, and the difference is the whole
		// report: `deadSelectors` stays empty and the remedy lives in the
		// `no-matchable-testids` warning.
		if (classification.verdict === "no-ui-evidence") {
			unverifiableSelectors += 1;
			unknownSelectors.push({
				defId: usage.defId,
				memberPath: usage.memberPath,
				loc: usage.loc,
				reason: "no-ui-evidence",
				raw: usage.text,
				origin: usage.origin,
			});
			continue;
		}

		if (classification.verdict === "dynamic-testid-expression") {
			const [witness] = classification.occurrences;
			unknownSelectors.push({
				defId: usage.defId,
				memberPath: usage.memberPath,
				loc: usage.loc,
				reason: "dynamic-testid-expression",
				raw: usage.text,
				origin: usage.origin,
				evidence: { raw: witness.value.raw, loc: witness.loc },
			});
			continue;
		}

		deadSelectors.push({
			defId: usage.defId,
			memberPath: usage.memberPath,
			loc: usage.loc,
			text: usage.text,
			origin: usage.origin,
			nearestTestIds: nearestIds(
				usage.testId ?? usage.pattern?.literalPrefix ?? "",
				renderedIndex.byId.keys(),
			),
			// The caveat travels with the entry. At app scale most dead selectors
			// were artifacts of a scope that never saw the sibling package their id
			// renders in, and an agent reading one entry — or a list `limit` cut —
			// had nothing on it to say so. Uniform across the run: see the field's
			// own JSDoc for why guessing a per-entry culprit would be a lie.
			...(scopeIncomplete ? { scopeIncomplete: true as const } : {}),
		});
	}
	deadSelectors.sort((a, b) => a.memberPath.localeCompare(b.memberPath));

	const uncoveredTestIds: CoverageReport["uncoveredTestIds"] =
		partition.rendered
			.filter((ui) => !coveredUi.has(ui))
			.map((ui) => {
				const speculative = speculativeCredit.get(ui);
				return {
					id: ui.id,
					patternSource: ui.patternSource,
					occurrences: ui.occurrences,
					suggestion: suggestionFor(ui),
					...(speculative ? { speculativeSelectors: speculative } : {}),
				};
			})
			.sort((a, b) =>
				String(a.id ?? a.patternSource).localeCompare(
					String(b.id ?? b.patternSource),
				),
			);

	const unknownTestIds: UnknownTestId[] = [
		...partition.dynamic.map((occurrence) => ({
			reason: "dynamic-value" as const,
			occurrence,
		})),
		...partition.prop.flatMap((ui) =>
			ui.occurrences.map((occurrence) => ({
				reason: "forwarding-unproven" as const,
				occurrence,
			})),
		),
		...partition.catchAll.map((occurrence) => ({
			reason: "unanchored-pattern" as const,
			occurrence,
			...(occurrence.value.kind === "pattern"
				? { patternSource: occurrence.value.regex.source }
				: {}),
		})),
	];

	const matchable = partition.rendered.length;
	const assumedGroups = partition.rendered.filter((ui) => ui.assumed).length;
	const rawSelectors = usages.filter((usage) => usage.origin === "raw").length;
	// One side of the report was narrowed and the other was not. Read once, so the
	// nulled ratio and the warning explaining it cannot disagree.
	const scopedToPageObjects =
		options.poInclude !== undefined && options.poInclude.length > 0;

	warnings.push(
		...coverageWarnings({
			attribute,
			partition,
			matchable,
			uiTree,
			assumeForwarded,
			assumedGroups,
			unprovenSelectors,
			unverifiableSelectors,
			catchAllSelectors,
			testIdSelectors: testIdUsages.length,
			deadCount: deadSelectors.length,
			includeRawLocators: options.includeRawLocators === true,
			poInclude: options.poInclude,
			scopedToPageObjects,
			coveredUi: coveredUi.size,
			uncovered: uncoveredTestIds.length,
		}),
	);

	return {
		schemaVersion: 1,
		attribute: attribute.attribute,
		summary: {
			uiTestIds: matchable + unknownTestIds.length,
			matchableUiTestIds: matchable,
			coveredUiTestIds: coveredUi.size,
			testIdSelectors: testIdUsages.length,
			rawSelectors,
			matched: matched.length,
			deadSelectors: deadSelectors.length,
			nonTestIdSelectors: nonTestIdSelectors.length,
			unknownSelectors: unknownSelectors.length,
			unknownTestIds: unknownTestIds.length,
			uncoveredTestIds: uncoveredTestIds.length,
			catchAllTestIds: partition.catchAll.length,
			...(assumeForwarded ? { assumedForwardedTestIds: assumedGroups } : {}),
			staticUiIdsCompared: renderedIndex.statics.length,
			// Zero of zero used to ship as `1`. A report that says "100 % covered"
			// because it found nothing to cover is the most expensive lie in here.
			//
			// A *scoped* run is the second way this number lies, and the fix is the
			// same one. `poInclude` narrows the numerator to the selectors of a few
			// files while the denominator stays every matchable id the scan found,
			// so one page object of a hundred scored 0.0366 — a number that reads as
			// a broken suite and is really just a ratio between two different
			// questions. Narrowing the denominator instead is not available: nothing
			// statically ties a page object to a subset of the UI (it names strings
			// and imports no components), so "the ids these classes could plausibly
			// match" is either undefined or circular — the ids they *did* match,
			// which would score every scoped run 1. Null plus a warning naming both
			// halves is the honest answer; `coveredUiTestIds` and
			// `matchableUiTestIds` still ship, so a caller who wants the ratio can
			// see exactly which two numbers it would divide.
			coverage:
				matchable === 0 || scopedToPageObjects
					? null
					: coveredUi.size / matchable,
		},
		scope: {
			uiFilesScanned: uiTree.stats.files,
			// Files that actually contributed a selector, not the size of the
			// include list. A `class` scope pulls in every page object nested under
			// it, so a report drawn from seven files reported "1" — and the
			// scope-narrowed warning repeated it in prose. Same defect as counting a
			// display-capped array: a number derived from the input rather than from
			// what the run did.
			// Page-object selectors only. `usages` also carries the raw-locator
			// sweep when `includeRawLocators` is on, and counting those made every
			// spec file with a `getByTestId` in it a "page-object file" — one page
			// object and forty specs reported forty-one, in the block a reader
			// consults precisely to judge how much the report covers.
			pageObjectFilesScanned: new Set(
				pageObjectUsages.map((usage) => usage.loc.file),
			).size,
			externalComponentModules: uiTree.externalModules,
			externalComponentTags: uiTree.stats.externalComponentTags,
		},
		matched,
		uncoveredTestIds,
		deadSelectors,
		nonTestIdSelectors,
		unknownSelectors,
		unknownTestIds,
		// The UI tree and the page-object index both seed themselves from the same
		// environment warnings, so every one of those arrives here twice.
		warnings: dedupeDiagnostics(warnings),
	};
}

/**
 * What an incomplete UI scope means for reading the report, and what to do.
 *
 * Two sentences here were measured backwards against a production monorepo and
 * are written the other way round now.
 *
 * **Triage order.** The old text said to start with the dead selectors whose
 * `nearestTestIds` is empty. Of 8 selectors that were *not* really dead, 6 had
 * an empty list — they name ids rendered inside an unscanned package, so
 * nothing in scope resembles them — while 3 of the 5 genuinely dead ones had a
 * near match, because a rename leaves the old spelling one edit away from the
 * new one. Emptiness is the signature of the scope gap; a near match is the
 * signature of the typo. So a near match is the actionable case.
 *
 * **The remedy.** The old text offered "rooted where they live, or with their
 * directories added to the scanned sources" as equal options. They are not:
 * anything outside the analysed root is dropped before it is counted, so
 * widening the scanned directories to reach a sibling package cannot work —
 * and a front end that validates its scope against its root refuses to start
 * at all. Re-rooting is the only one of the two that reaches them, and when
 * the modules resolve to source it can even be named exactly.
 */
/**
 * The same id, also written somewhere as a component prop nobody proved.
 *
 * A match is made against the *rendered* side, so an entry only ever names
 * elements the scan proved reach the DOM. That is right, and on its own it
 * misleads: an id can exist on both sides, and then a confident-looking entry
 * points at the one place that matched while the site the caller's page object
 * actually targets sits in the unproven partition, unmentioned.
 *
 * Measured on a production repository: `GuestsPageObject…Info` came back
 * `confidence: "exact"` against `HistoryEventItem.tsx`, an unrelated component,
 * while the `<WithIcon data-tid="Info">` the page object was written for is a
 * component prop that never reaches the DOM — a genuinely broken selector the
 * report presented as a clean match. The match is not wrong; presenting it as
 * the whole story is. So the entry now says the id has other, unproven sites,
 * and how many.
 */
function alsoUnproven(matches: Match[]): {
	unprovenOccurrences?: number;
	unprovenAt?: SourceLoc;
} {
	let count = 0;
	let first: SourceLoc | undefined;
	for (const match of matches) {
		count += match.ui.occurrences.length;
		if (!first) {
			first = match.ui.occurrences[0]?.loc;
		}
	}
	return count > 0 && first
		? { unprovenOccurrences: count, unprovenAt: first }
		: {};
}

export { type ScopeEvidence, scopeMessage } from "./coverageWarnings";
// Both are public and have always been reached through this module: the
// barrel re-exports `partitionInventory`, and `scopeMessage` is what the MCP
// layer calls to explain a narrowed scope.
export { type InventoryPartition, partitionInventory } from "./inventory";
