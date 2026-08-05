import { Node, SyntaxKind } from "ts-morph";
import { info } from "../diagnostics";
import { discoverInternal } from "../page-objects/discover";
import { buildTestIdTree } from "../tsx/tree";
import type {
	CoverageReport,
	Diagnostic,
	SelectorInfo,
	SelectorUsage,
	SourceLoc,
	TestIdOccurrence,
	UiTestId,
} from "../types";
import { literalPrefixOf, parseRegexLiteral } from "../util/literal";
import { keyFold } from "../util/paths";
import type { Workspace } from "../workspace";
import { matchSelectorToUi } from "./match";
import { nearestIds } from "./suggest";

export interface CoverageOptions {
	attribute?: string;
	/** Also sweep spec files for direct `getByTestId(...)` calls. */
	includeRawLocators?: boolean;
	uiInclude?: string[];
	poInclude?: string[];
}

const SPEC_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/;

/** Groups the flat inventory into one record per distinct id or pattern. */
export function groupUiTestIds(inventory: TestIdOccurrence[]): {
	testIds: UiTestId[];
	unknown: TestIdOccurrence[];
} {
	const byKey = new Map<string, UiTestId>();
	const unknown: TestIdOccurrence[] = [];

	for (const occurrence of inventory) {
		const value = occurrence.value;
		if (value.kind === "static" && value.value !== undefined) {
			const key = `s:${value.value}`;
			const existing = byKey.get(key);
			if (existing) {
				existing.occurrences.push(occurrence);
			} else {
				byKey.set(key, {
					id: value.value,
					patternSource: null,
					prefix: value.value,
					occurrences: [occurrence],
				});
			}
			continue;
		}
		if (value.kind === "pattern" && value.regex) {
			const key = `p:${value.regex.source}`;
			const existing = byKey.get(key);
			if (existing) {
				existing.occurrences.push(occurrence);
			} else {
				byKey.set(key, {
					id: null,
					patternSource: value.regex.source,
					patternFlags: value.regex.flags,
					prefix: value.prefix ?? null,
					occurrences: [occurrence],
				});
			}
			continue;
		}
		unknown.push(occurrence);
	}

	return { testIds: [...byKey.values()], unknown };
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

/** Direct `page.getByTestId("X")` calls in spec files. */
function sweepRawLocators(ws: Workspace): SelectorUsage[] {
	const usages: SelectorUsage[] = [];
	for (const sourceFile of ws.sourceFiles()) {
		const rel = ws.rel(sourceFile.getFilePath());
		if (!SPEC_FILE.test(rel)) {
			continue;
		}
		for (const call of sourceFile.getDescendantsOfKind(
			SyntaxKind.CallExpression,
		)) {
			const callee = call.getExpression();
			if (
				!Node.isPropertyAccessExpression(callee) ||
				callee.getName() !== "getByTestId"
			) {
				continue;
			}
			const [argument] = call.getArguments();
			if (!argument) {
				continue;
			}
			const loc = ws.loc(call);
			const text = call.getText().replace(/\s+/g, " ").slice(0, 200);
			if (
				Node.isStringLiteral(argument) ||
				Node.isNoSubstitutionTemplateLiteral(argument)
			) {
				usages.push({
					defId: rel,
					memberPath: `${rel}:${loc.line}`,
					loc,
					kind: "testId",
					text,
					testId: argument.getLiteralValue(),
					dynamic: false,
					origin: "raw",
				});
				continue;
			}
			if (Node.isRegularExpressionLiteral(argument)) {
				const regex = parseRegexLiteral(argument.getText());
				usages.push({
					defId: rel,
					memberPath: `${rel}:${loc.line}`,
					loc,
					kind: "testIdPattern",
					text,
					pattern: {
						source: regex.source,
						flags: regex.flags,
						origin: "regex",
						matchMode: "regex",
						literalPrefix: literalPrefixOf(regex.source),
					},
					dynamic: false,
					origin: "raw",
				});
			}
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

/**
 * Cross-references UI test ids against page-object selectors.
 *
 * Role, text, label, placeholder, alt-text and title selectors go to their own
 * bucket and are *never* counted as dead. `@SelectorByRole("button", { name:
 * "Apply" })` is a first-class selector; flagging it would train people to
 * ignore the report.
 */
export function buildCoverageReport(
	ws: Workspace,
	options: CoverageOptions = {},
): CoverageReport {
	const attribute = options.attribute
		? { attribute: options.attribute, source: "param" as const }
		: ws.testIdAttribute();
	const warnings: Diagnostic[] = [];

	const uiTree = buildTestIdTree(ws, {
		attribute: attribute.attribute,
		include: options.uiInclude,
	});
	warnings.push(...uiTree.warnings);

	const discovery = discoverInternal(ws, { include: options.poInclude });
	warnings.push(...discovery.index.warnings);

	const { testIds, unknown } = groupUiTestIds(uiTree.inventory);
	const usages = [
		...collectSelectorUsages(discovery),
		...(options.includeRawLocators ? sweepRawLocators(ws) : []),
	];

	const matched: CoverageReport["matched"] = [];
	const nonTestIdSelectors: CoverageReport["nonTestIdSelectors"] = [];
	const unknownSelectors: CoverageReport["unknownSelectors"] = [];
	const testIdUsages: SelectorUsage[] = [];

	for (const usage of usages) {
		if (usage.kind === "custom" || usage.dynamic) {
			unknownSelectors.push({
				defId: usage.defId,
				memberPath: usage.memberPath,
				loc: usage.loc,
				reason: usage.reason ?? "custom-selector",
				raw: usage.text,
			});
			continue;
		}
		if (usage.kind === "testId" || usage.kind === "testIdPattern") {
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

	const coveredUi = new Set<UiTestId>();
	const liveSelectors = new Set<SelectorUsage>();

	for (const usage of testIdUsages) {
		for (const ui of testIds) {
			const outcome = matchSelectorToUi(
				{ testId: usage.testId, pattern: usage.pattern },
				ui,
			);
			if (!outcome) {
				continue;
			}
			coveredUi.add(ui);
			liveSelectors.add(usage);
			matched.push({
				selector: {
					defId: usage.defId,
					memberPath: usage.memberPath,
					loc: usage.loc,
					kind: usage.kind,
					text: usage.text,
				},
				ui: {
					id: ui.id,
					patternSource: ui.patternSource,
					occurrences: ui.occurrences.map((occurrence) => occurrence.loc),
				},
				confidence: outcome.confidence,
				...(outcome.probe ? { probe: outcome.probe } : {}),
			});
		}
	}

	const staticIds = testIds
		.map((ui) => ui.id)
		.filter((id): id is string => id !== null);

	const uncoveredTestIds: CoverageReport["uncoveredTestIds"] = testIds
		.filter((ui) => !coveredUi.has(ui))
		.map((ui) => ({
			id: ui.id,
			patternSource: ui.patternSource,
			occurrences: ui.occurrences,
			suggestion: suggestionFor(ui),
		}))
		.sort((a, b) =>
			String(a.id ?? a.patternSource).localeCompare(
				String(b.id ?? b.patternSource),
			),
		);

	const deadSelectors: CoverageReport["deadSelectors"] = testIdUsages
		.filter((usage) => !liveSelectors.has(usage))
		.map((usage) => ({
			defId: usage.defId,
			memberPath: usage.memberPath,
			loc: usage.loc,
			text: usage.text,
			nearestTestIds: nearestIds(
				usage.testId ?? usage.pattern?.literalPrefix ?? "",
				staticIds,
			),
		}))
		.sort((a, b) => a.memberPath.localeCompare(b.memberPath));

	if (!options.includeRawLocators) {
		warnings.push(
			info(
				"raw-locators-disabled",
				"Direct `getByTestId(...)` calls in spec files were not scanned; an uncovered test id does not necessarily mean it is untested. Pass includeRawLocators to include them.",
			),
		);
	}

	const matchable = testIds.length;
	return {
		schemaVersion: 1,
		attribute: attribute.attribute,
		summary: {
			uiTestIds: matchable + unknown.length,
			matchableUiTestIds: matchable,
			coveredUiTestIds: coveredUi.size,
			testIdSelectors: testIdUsages.length,
			deadSelectors: deadSelectors.length,
			nonTestIdSelectors: nonTestIdSelectors.length,
			unknownSelectors: unknownSelectors.length,
			unknownTestIds: unknown.length,
			coverage: matchable === 0 ? 1 : coveredUi.size / matchable,
		},
		matched,
		uncoveredTestIds,
		deadSelectors,
		nonTestIdSelectors,
		unknownSelectors,
		unknownTestIds: unknown,
		warnings,
	};
}
