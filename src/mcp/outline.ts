import type {
	TestIdTree,
	TestIdValue,
	UiNode,
	UiUnresolvedReason,
} from "../analysis";

/**
 * Token-lean plain-text renderers for the two tree shapes.
 *
 * Outline is for reading, not parsing, and it is what both tree tools return by
 * default (`schemas.ts`); `format: "json"` is the complete, machine-parseable
 * form. This header said the opposite for four commits after the flip.
 */

// The page-object renderer lives next door; re-exported so callers and its
// own spec keep one import path.
export { renderPageObjectOutline } from "./pageObjectOutline";

/**
 * Plain-language label for a hole in the tree.
 *
 * One `unresolved: <code>` bucket collided with the documented meaning of the
 * word: "the depth limit stopped here", "this component ships from npm" and
 * "there is JSX in here we could not place" are three different things to do
 * next, and a reader has to be able to tell them apart at a glance.
 */
function unresolvedLabel(reason: UiUnresolvedReason): string {
	switch (reason) {
		case "external-module":
			return "external module";
		case "identifier-unresolved":
			return "unresolved import";
		case "namespaced-component":
			return "namespaced tag";
		case "not-a-function-component":
			return "not a function component";
		case "recursive":
			return "recursion cut";
		case "not-followed":
			return "not followed";
		case "depth-limit-reached":
			return "depth limit";
		case "node-budget-reached":
			return "node budget";
		case "local-render-function":
			return "local render function";
		case "imported-render-function":
			return "imported render function";
		case "unresolved-jsx":
			return "hole: unresolved-jsx";
		case "opaque-expression":
			return "hole: opaque";
		case "spread-props":
			return "spread props";
		default:
			// The code itself, not the last label that happened to be here. The
			// default used to read "spread props", so any reason added to the union
			// would have been labelled as a spread until someone noticed.
			return reason;
	}
}

/** `slot` for children, `prop <name>` for anything else the caller passed in. */
function placementLabel(placement: NonNullable<UiNode["placement"]>): string {
	return placement.kind === "slot" ? "slot" : `prop ${placement.name}`;
}

/** How one test-id value reads in an outline: a pattern as its prefix + `*`. */
function idLabel(value: UiNode["testId"]): string {
	if (!value) {
		return "-";
	}
	return testIdLabel(value);
}

/**
 * How an id reads in an outline: the value when it is one, the prefix glob when
 * it is a pattern, the source text when it is neither.
 */
function testIdLabel(value: TestIdValue): string {
	switch (value.kind) {
		case "static":
			return value.value;
		case "pattern":
			return `${value.prefix ?? ""}*`;
		default:
			return value.raw;
	}
}

/**
 * The three reductions below apply to the outline and to nothing else.
 *
 * Outline is the documented lossy reading format — it already drops visibility,
 * JSDoc and column numbers — and it is the one the instructions tell an agent to
 * prefer, so it is where payload size actually costs something. The JSON format
 * stays byte-for-byte complete for programmatic callers, and no honesty marker
 * is ever *removed* from the analysis: a hole is summarised with its reason and
 * count intact, never dropped.
 *
 * Measured on one production page component (`GuestsPage.tsx`, 375 lines,
 * 59,173 B): a component's internals rendered eight times over accounted for
 * 7,474 B, and nodes carrying neither an id nor a hole for 10,245 B.
 */

/** Fewer than this many sibling holes read better one per line. */
const MIN_AGGREGATED_HOLES = 3;

/** Enough tag names to recognise the group; the count carries the rest. */
const MAX_NAMED_TAGS = 5;

/**
 * Whether a node earns its line.
 *
 * An id is the answer the tool exists for; a hole is the honesty marker that
 * stops absence being read as proof; `testIdAbsent` and `testIdAlternatives`
 * are both statements about an id at this site; and `expandedAt` says the same
 * component renders here too, which is what tells a reader an id appears more
 * than once in the DOM. Everything else is a structural link — a provider, a
 * layout wrapper — and page objects chain by test id, not by DOM ancestry, so
 * dropping it costs a selector nothing.
 */
function worthPrinting(node: UiNode): boolean {
	return (
		node.testId !== undefined ||
		node.unresolved !== undefined ||
		node.testIdAbsent === true ||
		(node.testIdAlternatives?.length ?? 0) > 0 ||
		node.expandedAt !== undefined ||
		node.children.some(worthPrinting)
	);
}

/**
 * A node whose line would carry a tag and a location and nothing else.
 *
 * Providers, context wrappers and layout shells: they have no id, no hole, and
 * not one flag to their name. Their children are spliced into their parent, so
 * the tree keeps every node that says something and loses the scaffolding
 * between them. Nesting in an outline already means "renders inside", not "is a
 * direct DOM child" — component boundaries are collapsed throughout — and page
 * objects chain by test id rather than by ancestry, so no selector changes.
 *
 * Deliberately strict: any flag at all keeps the node, including `conditional`
 * and `placement`, so nothing that qualifies what renders is ever spliced away.
 */
function saysNothing(node: UiNode): boolean {
	return (
		node.testId === undefined &&
		node.unresolved === undefined &&
		node.testIdAbsent === undefined &&
		node.expandedAt === undefined &&
		node.placement === undefined &&
		node.conditional !== true &&
		node.repeated !== true &&
		node.viaDefault === undefined &&
		(node.testIdAlternatives?.length ?? 0) === 0
	);
}

/** The children to print for a node, with silent scaffolding spliced out. */
function effectiveChildren(node: UiNode): UiNode[] {
	const out: UiNode[] = [];
	for (const child of node.children) {
		if (!worthPrinting(child)) {
			continue;
		}
		if (saysNothing(child)) {
			out.push(...effectiveChildren(child));
			continue;
		}
		out.push(child);
	}
	return out;
}

/** A hole with nothing under it: the whole of its content is its reason. */
function isLeafHole(node: UiNode): boolean {
	return (
		node.unresolved !== undefined &&
		node.testId === undefined &&
		!node.children.some(worthPrinting)
	);
}

function renderUiNode(
	node: UiNode,
	indent: string,
	lines: string[],
	parentFile?: string,
): void {
	const flags: string[] = [];
	if (node.testId?.kind === "pattern") {
		flags.push(`dynamic ${node.testId.raw}`);
	} else if (node.testId?.kind === "dynamic") {
		flags.push(`dynamic ${node.testId.raw}`);
	}
	// Every branch of a static choice, because the outline is the format an agent
	// actually reads: printing only the first one says `data-testid={big ? "Main"
	// : "Alt"}` renders `Main`, and a selector for `Alt` then looks invented.
	if (node.testIdAlternatives && node.testIdAlternatives.length > 0) {
		flags.push(`or ${node.testIdAlternatives.map(idLabel).join(", ")}`);
	}
	if (node.placement) {
		flags.push(placementLabel(node.placement));
	}
	if (node.conditional) {
		flags.push("conditional");
	}
	if (node.repeated) {
		flags.push("repeated");
	}
	if (node.viaDefault) {
		flags.push("viaDefault");
	}
	// Not "dynamic": the attribute is written and renders nothing here. An agent
	// reading "dynamic" would go looking for the value.
	if (node.testIdAbsent) {
		flags.push("id absent at this site");
	}
	if (node.unresolved) {
		// The expression, where the reason names one: "local render function" says
		// what kind of hole it is, `getCheckinIcon()` says which one to go and read.
		flags.push(
			node.unresolved.raw
				? `${unresolvedLabel(node.unresolved.reason)} ${node.unresolved.raw}`
				: unresolvedLabel(node.unresolved.reason),
		);
	}

	if (node.expandedAt) {
		flags.push(`see ${node.expandedAt.file}:${node.expandedAt.line}`);
	}

	const id = idLabel(node.testId);
	// The path only where it changes. Measured on one production page component,
	// 232 of 310 lines repeated the file their parent had already named, and
	// those repeats were 40% of the whole outline — more than every other
	// reduction here put together. A bare `:106` inherits the nearest file above
	// it, which is how an indented outline is read anyway, and the JSON format
	// still carries the full `loc` on every node for anything that parses.
	const location =
		parentFile !== undefined && node.file === parentFile
			? `:${node.loc.line}`
			: `${node.file}:${node.loc.line}`;
	const flagText = flags.length > 0 ? ` (${flags.join(", ")})` : "";
	lines.push(`${indent}${id}  ${node.tag}  ${location}${flagText}`);

	for (const child of node.children) {
		renderUiNode(child, `${indent}  `, lines, node.file);
	}
}

/**
 * The one line a node contributes, without its indent or its children.
 *
 * `parentFile` is the *lexical* parent's file, never the previously printed
 * line's: a subtree has to render identically wherever it appears, or the
 * back-reference below would miss the copies it exists to collapse.
 */
function uiNodeLine(node: UiNode, parentFile?: string): string {
	const own: string[] = [];
	renderUiNode({ ...node, children: [] }, "", own, parentFile);
	return own[0];
}

/**
 * A run of sibling holes as one line.
 *
 * On a repository whose UI comes largely from packages, these are the bulk of
 * the tree: 293 of 375 lines on the measured page. Individually they say the
 * same thing over and over — "there is a component here we cannot enter" — and
 * what a reader needs from them is the reason and the scale, both of which
 * survive. `meta.fidelityReason` counts them exactly, so nothing is lost that
 * the response does not still state.
 */
function aggregatedHoles(holes: UiNode[]): string {
	const reason = unresolvedLabel(
		holes[0].unresolved?.reason ?? "opaque-expression",
	);
	const tags = [...new Set(holes.map((hole) => hole.tag))];
	const named = tags.slice(0, MAX_NAMED_TAGS).join(", ");
	const more =
		tags.length > MAX_NAMED_TAGS
			? `, +${tags.length - MAX_NAMED_TAGS} more`
			: "";
	return `... ${holes.length} boundaries not expanded (${reason}: ${named}${more})`;
}

/** Per-render state for collapsing subtrees that have already been printed. */
interface OutlineContext {
	/** Rendered children block to where it was first printed. */
	seen: Map<string, string>;
}

/**
 * Renders one node and its kept children, relative to indent zero.
 *
 * Children are rendered before the decision to print them, because that is the
 * only way to know whether this component's contents are the ones already shown
 * somewhere else. The engine cannot dedup these: it holds `conditional` and
 * `repeated` in the expansion key, deliberately, since those flags differ on
 * every descendant and `expandedAt` promises two expansions are identical.
 * Here the rendered text settles it, and the reference names the site to read.
 */
function renderUiBlock(
	node: UiNode,
	ctx: OutlineContext,
	parentFile?: string,
): string[] {
	const holes: UiNode[] = [];
	const rest: UiNode[] = [];
	for (const child of effectiveChildren(node)) {
		(isLeafHole(child) ? holes : rest).push(child);
	}

	const childLines: string[] = [];
	for (const child of rest) {
		for (const line of renderUiBlock(child, ctx, node.file)) {
			childLines.push(`  ${line}`);
		}
	}
	// Grouped by reason, and only once there are enough of them to be noise.
	const byReason = new Map<string, UiNode[]>();
	for (const hole of holes) {
		const key = hole.unresolved?.reason ?? "opaque-expression";
		const group = byReason.get(key);
		if (group) {
			group.push(hole);
		} else {
			byReason.set(key, [hole]);
		}
	}
	for (const group of byReason.values()) {
		if (group.length >= MIN_AGGREGATED_HOLES) {
			childLines.push(`  ${aggregatedHoles(group)}`);
			continue;
		}
		for (const hole of group) {
			childLines.push(`  ${uiNodeLine(hole, node.file)}`);
		}
	}

	const own = uiNodeLine(node, parentFile);
	// One line of contents is not worth a back-reference to go and find.
	if (childLines.length < 2) {
		return [own, ...childLines];
	}
	// Keyed on the file too. The lines carry only `:line` once the path is
	// elided, so two same-shaped subtrees in different files whose children sit
	// on matching line numbers hashed identically, and the second collapsed into
	// a back-reference pointing at the wrong file.
	const key = `${node.file}\u0000${childLines.join("\n")}`;
	const first = ctx.seen.get(key);
	if (first) {
		return [own, `  (contents as at ${first})`];
	}
	ctx.seen.set(
		key,
		`${rest[0]?.file ?? node.file}:${rest[0]?.loc.line ?? node.loc.line}`,
	);
	return [own, ...childLines];
}

export function renderTestIdOutline(tree: TestIdTree): string {
	const lines: string[] = [];
	if (tree.roots.length === 0) {
		lines.push(`(flat inventory, ${tree.inventory.length} occurrences)`);
		for (const occurrence of tree.inventory) {
			const id = testIdLabel(occurrence.value);
			// Flat is the fallback fidelity, so it is exactly when the per-occurrence
			// metadata the full tree carries matters most.
			const flags: string[] = [];
			if (occurrence.value.kind !== "static") {
				flags.push(`dynamic ${occurrence.value.raw}`);
			}
			if (occurrence.conditional) {
				flags.push("conditional");
			}
			if (occurrence.repeated) {
				flags.push("repeated");
			}
			if (occurrence.viaProp) {
				flags.push(`viaProp ${occurrence.viaProp}`);
			}
			const flagText = flags.length > 0 ? ` (${flags.join(", ")})` : "";
			lines.push(
				`${id}  ${occurrence.tag}  ${occurrence.file}:${occurrence.loc.line}${flagText}`,
			);
		}
		return lines.join("\n");
	}
	const ctx: OutlineContext = { seen: new Map() };
	// A root that says nothing is still printed: it is what the caller named, and
	// splicing it away would answer a different question than the one asked.
	for (const root of tree.roots) {
		// A root with nothing worth printing under it is still printed: it is what
		// the caller asked to see, and an empty answer has to look like one.
		lines.push(...renderUiBlock(root, ctx));
	}
	return lines.join("\n");
}
