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
import { isCatchAllPattern } from "./match";
import { nearestIds } from "./suggest";

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

/** Locator calls whose first argument is a test id. */
const RAW_CALL_NAMES = new Set([
	"getByTestId",
	"getItemByTestId",
	"filterByItemTestId",
	"filterByHasTestId",
]);

/**
 * Cheap pre-filter for the raw sweep: every call name above contains it.
 *
 * The sweep reads the same files discovery does, which in a real repository is
 * thousands. Descending into every `CallExpression` of every one of them costs
 * more than the rest of the report put together; a substring test on the file
 * text skips the overwhelming majority for the price of a scan.
 */
const RAW_CALL_MARKER = "TestId";

/** Evidence entries are for reading, not for exhaustive enumeration. */
const MAX_EVIDENCE_IDS = 5;

/**
 * Whether this run knows its view of the UI is partial.
 *
 * One definition, read twice: it gates the `ui-scope-incomplete` warning and it
 * stamps every dead selector. A per-entry flag that could disagree with the
 * warning it points the reader at would be worse than no flag at all.
 */
function uiScopeIncomplete(uiTree: TestIdTree): boolean {
	return uiTree.stats.externalComponentTags > 0;
}

export interface InventoryPartition {
	/** Ids proven to reach the DOM, grouped. Only these are matchable. */
	rendered: UiTestId[];
	/** Ids written as a prop on a component tag, with no forwarding proven. */
	prop: UiTestId[];
	/** Patterns that match every id, quarantined before they can match one. */
	catchAll: TestIdOccurrence[];
	/** Values that are not statically knowable at all. */
	dynamic: TestIdOccurrence[];
}

function addTo(
	byKey: Map<string, UiTestId>,
	key: string,
	occurrence: TestIdOccurrence,
	make: () => UiTestId,
	promoted: boolean,
): void {
	const existing = byKey.get(key);
	if (existing) {
		existing.occurrences.push(occurrence);
		// One genuinely rendered occurrence is enough: the group no longer owes its
		// existence to the assumption, so it must not be labelled as if it did.
		if (!promoted) {
			existing.assumed = undefined;
		}
		return;
	}
	const entry = make();
	if (promoted) {
		entry.assumed = true;
	}
	byKey.set(key, entry);
}

/**
 * Splits the flat inventory into the four states coverage can distinguish.
 *
 * Four, not two, because "rendered" and "not rendered" cannot express the two
 * cases that actually cause wrong reports: an id nobody has proven reaches the
 * DOM, and a pattern so loose it matches everything. Counting the first as
 * rendered invents coverage; matching against the second invents it wholesale.
 */
export function partitionInventory(
	inventory: TestIdOccurrence[],
	assumeForwarded = false,
): InventoryPartition {
	const renderedByKey = new Map<string, UiTestId>();
	const propByKey = new Map<string, UiTestId>();
	const catchAll: TestIdOccurrence[] = [];
	const dynamic: TestIdOccurrence[] = [];

	for (const occurrence of inventory) {
		const value = occurrence.value;
		const isProp = occurrence.reach === "component-prop";
		const promoted = isProp && assumeForwarded;
		const target = isProp && !assumeForwarded ? propByKey : renderedByKey;

		if (value.kind === "static" && value.value !== undefined) {
			const id = value.value;
			addTo(
				target,
				`s:${id}`,
				occurrence,
				() => ({
					id,
					patternSource: null,
					prefix: id,
					occurrences: [occurrence],
				}),
				promoted,
			);
			continue;
		}
		if (value.kind === "pattern" && value.regex) {
			if (isCatchAllPattern(value.regex.source)) {
				catchAll.push(occurrence);
				continue;
			}
			const regex = value.regex;
			addTo(
				target,
				`p:${regex.source}`,
				occurrence,
				() => ({
					id: null,
					patternSource: regex.source,
					patternFlags: regex.flags,
					prefix: value.prefix ?? null,
					occurrences: [occurrence],
				}),
				promoted,
			);
			continue;
		}
		dynamic.push(occurrence);
	}

	return {
		rendered: [...renderedByKey.values()],
		prop: [...propByKey.values()],
		catchAll,
		dynamic,
	};
}

/**
 * Builds `memberPath` prefixes by walking from the root page objects outward,
 * so a nested control reads as `CheckoutPage.CartItems[item].RemoveButton`
 * rather than as a bare class name.
 */
function assignPaths(
	discovery: ReturnType<typeof discoverInternal>,
): Map<string, string> {
	const paths = new Map<string, string>();
	const roots = [...discovery.classes.values()]
		.filter((entry) => {
			const kind = entry.classification.hostKind;
			return (
				kind === "rootPageObject" ||
				kind === "rootPlain" ||
				kind === "pageFallback" ||
				(discovery.fixtures.byClass.get(entry.foldedKey)?.length ?? 0) > 0
			);
		})
		.sort((a, b) => (a.className < b.className ? -1 : 1));

	const queue: Array<{ key: string; path: string }> = [];
	for (const root of roots) {
		if (!paths.has(root.foldedKey)) {
			paths.set(root.foldedKey, root.className);
			queue.push({ key: root.foldedKey, path: root.className });
		}
	}

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) {
			break;
		}
		const entry = discovery.classes.get(current.key);
		if (!entry) {
			continue;
		}
		for (const read of entry.members) {
			const result = read.member.result;
			for (const edge of read.edges) {
				const folded = keyFold(edge.ref);
				if (paths.has(folded) || !discovery.classes.has(folded)) {
					continue;
				}
				const isItem = result.kind === "list" && result.itemRef === edge.ref;
				const childPath = isItem
					? `${current.path}.${read.member.name}[item]`
					: `${current.path}.${read.member.name}`;
				paths.set(folded, childPath);
				queue.push({ key: folded, path: childPath });
			}
		}
	}

	return paths;
}

function collectSelectorUsages(
	discovery: ReturnType<typeof discoverInternal>,
): SelectorUsage[] {
	const paths = assignPaths(discovery);
	const usages: SelectorUsage[] = [];

	for (const entry of discovery.classes.values()) {
		const prefix = paths.get(entry.foldedKey) ?? entry.className;

		if (entry.rootSelector) {
			usages.push(
				toUsage(entry.key, prefix, entry.rootSelector, {
					file: entry.file,
					line: 0,
				}),
			);
		}
		for (const read of entry.members) {
			usages.push(
				toUsage(
					entry.key,
					`${prefix}.${read.member.name}`,
					read.member.selector,
					read.member.loc,
				),
			);
		}
	}

	return usages;
}

function toUsage(
	defId: string,
	memberPath: string,
	selector: SelectorInfo,
	loc: SourceLoc,
): SelectorUsage {
	const usage: SelectorUsage = {
		defId,
		memberPath,
		loc,
		kind: selector.kind,
		text: selector.raw,
		dynamic: selector.dynamic,
		origin: "page-object",
	};
	if (selector.kind === "testId" && typeof selector.testId === "string") {
		usage.testId = selector.testId;
	}
	if (selector.kind === "testIdPattern" && selector.pattern) {
		usage.pattern = selector.pattern;
	}
	return usage;
}

/** The call name, whether written as `page.getByTestId` or bare. */
function rawCallName(call: Node): string | null {
	if (!Node.isCallExpression(call)) {
		return null;
	}
	const callee = call.getExpression();
	if (Node.isPropertyAccessExpression(callee)) {
		return callee.getName();
	}
	if (Node.isIdentifier(callee)) {
		return callee.getText();
	}
	return null;
}

/**
 * Direct locator calls anywhere in the analysed sources.
 *
 * Two things were wrong with sweeping `*.spec.ts` for `getByTestId` alone. The
 * file filter assumed a naming convention — a repository whose Playwright tests
 * live in `checkout.e2e.ts`, or whose selectors sit in a helper module, got a
 * report claiming ids were unused when a call site was three lines away. And
 * `getByTestId` is one of four call names this library's own list page object
 * exposes, so `filterByHasTestId("Row")` counted for nothing.
 *
 * The argument is read with the same reader the JSX scan uses, so a template
 * literal becomes a pattern instead of being dropped, and an expression nobody
 * can evaluate becomes an honest `unknown` instead of silence.
 */
function sweepRawLocators(
	ws: Workspace,
	poInclude: string[] | undefined,
): SelectorUsage[] {
	const usages: SelectorUsage[] = [];
	for (const sourceFile of ws.sourceFiles()) {
		const rel = ws.rel(sourceFile.getFilePath());
		if (poInclude && poInclude.length > 0 && !matchesAnyGlob(rel, poInclude)) {
			continue;
		}
		if (!sourceFile.getFullText().includes(RAW_CALL_MARKER)) {
			continue;
		}
		for (const call of sourceFile.getDescendantsOfKind(
			SyntaxKind.CallExpression,
		)) {
			const name = rawCallName(call);
			if (name === null || !RAW_CALL_NAMES.has(name)) {
				continue;
			}
			const [argument] = call.getArguments();
			if (!argument) {
				continue;
			}
			const loc = ws.loc(call);
			const base = {
				defId: rel,
				memberPath: `${rel}:${loc.line}`,
				loc,
				text: call.getText().replace(/\s+/g, " ").slice(0, 200),
				origin: "raw" as const,
			};

			if (Node.isRegularExpressionLiteral(argument)) {
				const regex = parseRegexLiteral(argument.getText());
				usages.push({
					...base,
					kind: "testIdPattern",
					pattern: {
						source: regex.source,
						flags: regex.flags,
						origin: "regex",
						matchMode: "regex",
						literalPrefix: literalPrefixOf(regex.source),
					},
					dynamic: false,
				});
				continue;
			}

			const [value] = readExpressionValue(argument).values;
			if (!value) {
				continue;
			}
			if (value.kind === "static" && value.value !== undefined) {
				usages.push({
					...base,
					kind: "testId",
					testId: value.value,
					dynamic: false,
				});
				continue;
			}
			if (value.kind === "pattern" && value.regex) {
				usages.push({
					...base,
					kind: "testIdPattern",
					pattern: {
						source: value.regex.source,
						flags: value.regex.flags,
						origin: "string",
						matchMode: "regex",
						literalPrefix:
							value.prefix ?? literalPrefixOf(value.regex.source) ?? null,
					},
					dynamic: false,
				});
				continue;
			}
			usages.push({
				...base,
				kind: "testId",
				dynamic: true,
				reason: value.reason ?? "computed-expression",
			});
		}
	}
	return usages;
}

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
	const usages = [
		...collectSelectorUsages(discovery),
		...(options.includeRawLocators
			? sweepRawLocators(ws, options.poInclude)
			: []),
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
					...alsoUnproven(match.ui.id, sides),
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
			...(occurrence.value.regex
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
			pageObjectFilesScanned: new Set(usages.map((usage) => usage.loc.file))
				.size,
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
function coverageWarnings(inputs: WarningInputs): Diagnostic[] {
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
			partition.catchAll.map(
				(occurrence) => occurrence.value.regex?.source ?? "",
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
	} else if (inputs.poInclude && inputs.poInclude.length > 0) {
		out.push(
			info(
				"raw-locators-disabled",
				`The direct-locator sweep was limited to the same file scope as the page-object side (${inputs.poInclude.join(", ")}), so calls written anywhere else were not counted.`,
			),
		);
	}

	return out;
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
function alsoUnproven(
	id: string | null,
	sides: ClassifySides,
): { unprovenOccurrences?: number; unprovenAt?: SourceLoc } {
	if (id === null) {
		return {};
	}
	const group = sides.propById.get(id);
	const first = group?.occurrences[0];
	if (!group || !first) {
		return {};
	}
	return {
		unprovenOccurrences: group.occurrences.length,
		unprovenAt: first.loc,
	};
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
