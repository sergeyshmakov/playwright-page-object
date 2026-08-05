import type * as z from "zod";
import {
	buildCoverageReport,
	buildPageObjectTree,
	buildTestIdTree,
	discoverPageObjects,
	type PageObjectSummary,
	type SelectorInfo,
	type Workspace,
} from "../analysis";
import { ToolError } from "./errors";
import { renderPageObjectOutline, renderTestIdOutline } from "./outline";
import { ok } from "./respond";
import type {
	getPageObjectTreeInput,
	getTestIdTreeInput,
	listPageObjectsInput,
	mapCoverageInput,
} from "./schemas";

/**
 * Thin tool handlers: validate cross-field rules, call the analysis engine,
 * shape a token-lean payload, wrap in the response envelope.
 */

function compactSelector(selector: SelectorInfo): Record<string, unknown> {
	const compact: Record<string, unknown> = { kind: selector.kind };
	if (selector.testId !== undefined) {
		compact.testId = selector.testId;
	}
	if (selector.pattern) {
		compact.pattern = selector.pattern.source;
	}
	if (selector.role !== undefined) {
		compact.role = selector.role;
	}
	if (selector.text !== undefined) {
		compact.text = selector.text;
	}
	if (selector.options !== undefined) {
		compact.options = selector.options;
	}
	if (selector.dynamic) {
		compact.dynamic = true;
		compact.raw = selector.raw;
	}
	return compact;
}

function summaryEntry(summary: PageObjectSummary): Record<string, unknown> {
	const entry: Record<string, unknown> = {
		name: summary.className,
		file: summary.file,
		kind: summary.hostKind,
	};
	if (summary.rootSelector) {
		entry.root = compactSelector(summary.rootSelector);
	}
	if (summary.fixtures.length > 0) {
		entry.fixtures = summary.fixtures.map((fixture) => fixture.name);
	}
	entry.members = summary.counts.members;
	entry.methods = summary.counts.methods;
	if (summary.doc) {
		entry.doc = summary.doc;
	}
	return entry;
}

export function handleListPageObjects(
	workspace: Workspace,
	args: z.infer<typeof listPageObjectsInput>,
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
	const shown = items.slice(0, args.limit);

	return ok(shown.map(summaryEntry), {
		root: index.projectRoot,
		attribute: index.testIdAttribute,
		attributeSource: index.testIdAttributeSource,
		scanned: index.stats.filesScanned,
		total: total > shown.length ? total : undefined,
		warnings: index.warnings,
		hint:
			total === 0
				? 'No classes with playwright-page-object decorators were found. If your page objects live elsewhere, restart the server with --src-dir <dir>; also check that those files import from "playwright-page-object".'
				: undefined,
	});
}

export function handleGetPageObjectTree(
	workspace: Workspace,
	args: z.infer<typeof getPageObjectTreeInput>,
) {
	if (!args.class && !args.file) {
		throw new ToolError("invalid_input", "Provide `class`, `file`, or both.", {
			hint: 'Pass class (e.g. "CheckoutPage") or file. Call list_page_objects to see both.',
		});
	}

	const target =
		args.class && args.file
			? `${args.file}#${args.class}`
			: (args.class ?? args.file ?? "");

	const tree = buildPageObjectTree(workspace, target, {
		maxDepth: args.depth,
	});

	if (!args.includeMethods) {
		for (const def of Object.values(tree.defs)) {
			def.methods = [];
		}
	}

	const meta = {
		root: tree.projectRoot,
		attribute: tree.testIdAttribute,
		truncated: tree.truncated,
		warnings: tree.warnings,
	};

	if (args.format === "outline") {
		return ok(renderPageObjectOutline(tree), meta);
	}

	return ok({ root: tree.root, defs: tree.defs, stats: tree.stats }, meta);
}

export function handleGetTestIdTree(
	workspace: Workspace,
	args: z.infer<typeof getTestIdTreeInput>,
) {
	const depth = args.followComponents ? args.depth : 1;

	if (args.testId) {
		const tree = buildTestIdTree(workspace, {
			attribute: args.attribute,
			maxDepth: depth,
		});
		const needle = args.testId;
		const occurrences = tree.inventory.filter((occurrence) => {
			if (occurrence.value.kind === "static") {
				return occurrence.value.value === needle;
			}
			if (occurrence.value.kind === "pattern" && occurrence.value.regex) {
				return new RegExp(
					occurrence.value.regex.source,
					occurrence.value.regex.flags,
				).test(needle);
			}
			return false;
		});
		return ok(
			{ occurrences },
			{
				attribute: tree.attribute,
				attributeSource: tree.attributeSource,
				hint:
					occurrences.length === 0
						? `No rendered element with test id "${needle}" was found. Call get_testid_tree without testId to see the full tree, or map_coverage to check for renamed ids.`
						: undefined,
			},
		);
	}

	let entry = args.file;
	if (!entry && args.component) {
		const probe = buildTestIdTree(workspace, {
			attribute: args.attribute,
			maxDepth: 1,
		});
		const match = Object.values(probe.components).find(
			(component) => component.name === args.component,
		);
		if (!match) {
			throw new ToolError(
				"file_not_found",
				`No component named "${args.component}" was found in the scanned sources.`,
				{
					hint: "Pass `file` with the component's path instead, or omit both to auto-detect the app entry.",
				},
			);
		}
		entry = match.file;
	}

	const tree = buildTestIdTree(workspace, {
		attribute: args.attribute,
		entry,
		maxDepth: depth,
	});

	const meta = {
		attribute: tree.attribute,
		attributeSource: tree.attributeSource,
		fidelity: tree.fidelity,
		fidelityReason: tree.fidelityReason,
		truncated: tree.truncated,
		warnings: tree.warnings,
	};

	if (args.format === "outline") {
		return ok(renderTestIdOutline(tree), meta);
	}

	if (tree.fidelity === "flat") {
		return ok({ fidelity: "flat", inventory: tree.inventory }, meta);
	}

	return ok({ fidelity: "full", roots: tree.roots, stats: tree.stats }, meta);
}

export function handleMapCoverage(
	workspace: Workspace,
	args: z.infer<typeof mapCoverageInput>,
) {
	let poInclude: string[] | undefined;
	if (args.file) {
		poInclude = [args.file];
	} else if (args.class) {
		const index = discoverPageObjects(workspace);
		const matches = index.pageObjects.filter(
			(item) => item.className === args.class,
		);
		if (matches.length === 0) {
			const needle = (args.class ?? "").toLowerCase();
			const suggestions = index.pageObjects
				.filter((item) => item.className.toLowerCase().includes(needle))
				.map((item) => item.className)
				.slice(0, 5);
			throw new ToolError(
				"class_not_found",
				`No page object named "${args.class}" was found.`,
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
	}

	const report = buildCoverageReport(workspace, {
		attribute: args.attribute,
		poInclude,
	});

	const cap = <T>(list: T[]): T[] => list.slice(0, args.limit);
	const capped = {
		summary: report.summary,
		matched: cap(report.matched),
		...(args.includeUnused
			? { uncoveredTestIds: cap(report.uncoveredTestIds) }
			: {}),
		deadSelectors: cap(report.deadSelectors),
		nonTestIdSelectors: cap(report.nonTestIdSelectors),
		unknownSelectors: cap(report.unknownSelectors),
		unknownTestIds: cap(report.unknownTestIds),
	};

	const truncated =
		report.matched.length > args.limit ||
		report.uncoveredTestIds.length > args.limit ||
		report.deadSelectors.length > args.limit;

	return ok(capped, {
		attribute: report.attribute,
		warnings: report.warnings,
		truncated,
	});
}
