import type {
	Diagnostic,
	TestIdOccurrence,
	UiNode,
	UiUnresolvedReason,
} from "../../analysis";

/**
 * What a partial tree does not say, and what to do about it.
 *
 * Pure over the engine's output: every function here takes `UiNode[]` and plain
 * counts, and returns text or a small record. Nothing touches a `Workspace`, a
 * filesystem or ts-morph.
 *
 * That is why they live here rather than in `tools.ts`. Covering one arm of
 * {@link gapHint} used to mean authoring a repository on disk in which that
 * `UiUnresolvedReason` is the *plurality* of boundaries - `traversalGap` picks
 * its `topReason` by count - so a thirty-line reduction was pinned by a
 * three-file fixture, a booted client and a substring match. `outline.ts` next
 * door had shown the alternative all along.
 */

/**
 * Counts describing exactly the nodes shipped in `roots`.
 *
 * `unresolved` and `unresolvedByReason` repeat the engine's own tree counters
 * deliberately rather than being copied from `tree.stats`: those are the two
 * numbers a caller checks against the nodes actually in front of them, and a
 * stat that describes a different set than the payload is worse than none.
 * They agree with the engine here — the handler ships the engine's roots
 * unchanged — and the walk was already visiting every node.
 *
 * Zero-count reasons are omitted, so the keys are exactly this tree's holes.
 * `spread-props` is never one of them: it marks an unknown test-id *value* on a
 * node whose children are all present, not a missing subtree.
 */
export function subtreeStats(roots: UiNode[]): Record<string, unknown> {
	let nodes = 0;
	let testIds = 0;
	let patterns = 0;
	let dynamic = 0;
	let unresolved = 0;
	const byReason: Partial<Record<UiUnresolvedReason, number>> = {};
	const visit = (node: UiNode): void => {
		nodes += 1;
		if (node.testId) {
			testIds += 1;
			if (node.testId.kind === "pattern") {
				patterns += 1;
			} else if (node.testId.kind === "dynamic") {
				dynamic += 1;
			}
		}
		const reason = node.unresolved?.reason;
		if (reason && reason !== "spread-props") {
			unresolved += 1;
			byReason[reason] = (byReason[reason] ?? 0) + 1;
		}
		for (const child of node.children) {
			visit(child);
		}
	};
	for (const root of roots) {
		visit(root);
	}
	return {
		nodes,
		testIds,
		patterns,
		dynamic,
		unresolved,
		// An empty object would be noise on a complete tree; its absence and
		// `unresolved: 0` say the same thing once.
		...(unresolved > 0 ? { unresolvedByReason: byReason } : {}),
	};
}

export interface TreeGap {
	kind: "not-followed" | "depth" | "nodes" | "boundary";
	detail: string;
	/** Set for `boundary`: the reason that accounts for most of the gap. */
	reason?: UiUnresolvedReason;
}

/**
 * Why the walk could not see the whole tree, or `null` when it saw all of it.
 *
 * Only cuts that *hide* nodes count: the depth limit and the node budget stop
 * the walk outright, a component left unexpanded hides whatever it renders, and
 * a `#unresolved` marker stands for content the walk saw but could not place.
 * `spread-props` is not one of them — that marks an unknown test id on a node
 * whose children were still walked. `expandedAt` is not one either: the subtree
 * it points at is in this same tree.
 *
 * **Chosen by weight, not by rank.** This used to return the first hit in a
 * fixed order, so a single depth-limited node decided the advice for a tree
 * whose real problem was something else. Measured on one production page: 49
 * depth-limited sites against 178 `external-module` boundaries, and the reader
 * was told to re-call with a larger depth — advice that addresses 17% of the
 * gap. Following it cost 37% more bytes and returned nothing, because no depth
 * reaches inside a module that was never scanned.
 *
 * `not-followed` still wins outright when present: it is the only reason the
 * caller *chose*, so the fix is one argument away and no count changes that.
 */
export function traversalGap(
	roots: UiNode[],
	truncated: boolean,
): TreeGap | null {
	let notFollowed = 0;
	let depthCut = 0;
	const boundaries = new Map<UiUnresolvedReason, number>();
	const visit = (nodes: UiNode[]): void => {
		for (const node of nodes) {
			const reason = node.unresolved?.reason;
			if (reason === "not-followed") {
				notFollowed += 1;
			} else if (reason === "depth-limit-reached") {
				depthCut += 1;
			} else if (
				reason !== undefined &&
				reason !== "spread-props" &&
				// A budget cut is not a boundary. It is marked on a component node
				// like one, so counting it here made the widest reason
				// `node-budget-reached` and returned the generic "left unexpanded"
				// caveat — hiding the `nodes` gap below, which is the only one whose
				// advice a caller can act on (`maxNodes`). Left to the `truncated`
				// fallback, which is what the builder sets for exactly this case.
				reason !== "node-budget-reached" &&
				(node.nodeType === "component" || node.nodeType === "unresolved")
			) {
				boundaries.set(reason, (boundaries.get(reason) ?? 0) + 1);
			}
			visit(node.children);
		}
	};
	visit(roots);

	if (notFollowed > 0) {
		return {
			kind: "not-followed",
			detail: `${notFollowed} component tag(s) were reported without expanding them`,
		};
	}

	// The widest boundary reason, and how it compares with the depth cuts.
	let topReason: UiUnresolvedReason | undefined;
	let topCount = 0;
	for (const [reason, count] of boundaries) {
		if (count > topCount) {
			topReason = reason;
			topCount = count;
		}
	}

	if (topReason && topCount >= depthCut && topCount > 0) {
		return {
			kind: "boundary",
			detail:
				topCount === 1
					? `a component in that tree was left unexpanded (${topReason})`
					: `${topCount} component(s) in that tree were left unexpanded (${topReason})`,
			reason: topReason,
		};
	}
	if (depthCut > 0) {
		return {
			kind: "depth",
			detail: `the depth limit cut the walk short at ${depthCut} site(s)`,
		};
	}
	if (truncated) {
		return { kind: "nodes", detail: "the node budget ran out mid-walk" };
	}
	return null;
}

/**
 * What to do about a gap: the next call, not an apology.
 *
 * `meta.fidelityReason` already counts the holes and names their codes, so this
 * says only the two things it cannot — which argument closes the gap, and that
 * an id's absence from a holed tree proves nothing.
 */
export function gapHint(
	gap: TreeGap,
	depth: number,
	followComponents: boolean,
): string {
	const caveat =
		"An id missing from an incomplete tree may still be rendered; pass testId to look one up across the whole scan.";
	if (gap.kind === "not-followed") {
		return `Re-call with followComponents: true to see inside them. ${caveat}`;
	}
	if (gap.kind === "depth") {
		if (!followComponents) {
			return `Re-call with followComponents: true. ${caveat}`;
		}
		return depth >= 10
			? `Depth is already at the maximum. ${caveat}`
			: `Re-call with a larger depth (this call walked ${depth}, max 10). ${caveat}`;
	}
	if (gap.kind === "nodes") {
		return `The node budget ran out; re-call with file or component set to a narrower root. ${caveat}`;
	}
	// The commonest gap on a real application, and the one that used to get no
	// advice at all beyond the caveat — while a single depth-limited node
	// elsewhere in the tree hijacked the hint into recommending a bigger depth.
	// Each reason has a different answer and only one of them is a budget.
	switch (gap.reason) {
		case "external-module":
			return `Those components ship from outside the scanned sources, so no depth reaches inside them - re-root the server with --project-root covering their sources, or accept the gap. ${caveat}`;
		case "local-render-function":
			return `A same-file function returning JSX could not be inlined; its call is in the node's \`raw\`, so read that function directly. ${caveat}`;
		case "imported-render-function":
			return `A function imported from another file in this repository returns JSX and is called here; the call is in the node's \`raw\`. Its elements belong to that file, so root a tree there rather than expecting them inline. ${caveat}`;
		case "identifier-unresolved":
		case "namespaced-component":
		case "not-a-function-component":
			return `Those tags do not resolve to a function component the walk can enter. If one of them is a component in this repository, root a tree at it with \`component\`. ${caveat}`;
		case "recursive":
			return `The component renders itself and the walk cut the cycle; there is nothing to re-call with. ${caveat}`;
		default:
			return caveat;
	}
}

/**
 * Why a tree is not worth sending, or `undefined` when it is.
 *
 * A run whose attribute does not appear in the sources builds a real tree of
 * real components in which *every* node is id-less — 11 KB, on a repository
 * where the answer is "you are reading the wrong attribute". The environment
 * warning and `meta.hint` already say that, in full, and they are what the
 * caller has to act on; the nodes add nothing to them.
 *
 * Deliberately narrow. It fires only when the analysis has *proven* the payload
 * is empty of answers: an environment diagnostic that invalidates the whole
 * scan, and not one id anywhere in the tree. A tree with a single id is shipped
 * whole, because then the reader has something to check the warning against.
 */
export function blindScan(
	warnings: Diagnostic[],
	roots: UiNode[],
	gap: TreeGap | null,
): string | undefined {
	const hasId = (nodes: UiNode[]): boolean =>
		nodes.some((node) => node.testId !== undefined || hasId(node.children));
	if (roots.length === 0 || hasId(roots)) {
		return undefined;
	}

	const blinding = warnings.find(
		(warning) =>
			warning.code === "attribute-mismatch" ||
			warning.code === "attribute-no-evidence",
	);
	if (blinding) {
		return `Not one node in this tree carries a test id, because ${blinding.code}: this run read an attribute the sources do not use. The nodes were omitted rather than sent as an id-less shell - read the warning and the hint, fix the attribute, and re-call.`;
	}

	// The same shape from a different cause, and the expensive one in practice.
	// Rooting at a page component whose content sits behind a router or a
	// provider wall walks hundreds of scaffolding nodes and reaches no id at
	// all: 43 KB on the measured page, of which none was an answer. A *complete*
	// tree with no ids is a real finding and still ships - "this component
	// renders none" is worth knowing. A cut one proves nothing and costs most.
	if (gap) {
		return `This tree reached no test id at all, and the walk is incomplete (${gap.detail}), so its nodes prove nothing about what renders here - they were omitted. Pass testId to look an id up across the whole scan, which is complete whatever the walk did, and root a new tree at the file it names.`;
	}
	return undefined;
}

/** Ids named in a capped list, plus how many more there were. */
export interface IdsNotPlaced {
	ids: string[];
	total: number;
}

/** A short list is for reading; past this the count carries it. */
const MAX_UNPLACED_IDS = 12;

/**
 * Ids the walk read out of the files it visited but did not put in the tree.
 *
 * A partial tree says "293 of 375 nodes were left unexpanded", which is a
 * count, not a list — so an agent cannot tell "this id does not exist" from
 * "the walk did not reach it", and the whole promise of the tool is that
 * absence means something. Measured: a tree rooted at `GuestsList.tsx` reported
 * ids from lines 29–50 of a component file and silently omitted two from lines
 * 18 and 23 of that same file, which `map_coverage` located exactly.
 *
 * Scoped to files the tree actually walked, deliberately. Scan-wide this would
 * be ~1,500 entries on a real repository and useless; restricted this way it is
 * short, exact, and answers the question that was asked. The inventory is
 * complete in every fidelity mode, so this is a set difference over data the
 * response already holds — no extra analysis.
 */
export function idsNotPlaced(
	roots: UiNode[],
	inventory: TestIdOccurrence[],
): IdsNotPlaced | undefined {
	const walkedFiles = new Set<string>();
	const placed = new Set<string>();
	const visit = (nodes: UiNode[]): void => {
		for (const node of nodes) {
			walkedFiles.add(node.file);
			// Both halves of a static choice. `data-testid={flag ? "Main" : "Alt"}`
			// keeps `Main` in `testId` and `Alt` in `testIdAlternatives`, and the
			// inventory holds both — so counting only the first reported `Alt` as an
			// id the tree failed to place while it was sitting on that very node.
			for (const value of [node.testId, ...(node.testIdAlternatives ?? [])]) {
				if (value?.kind === "static" && value.value !== undefined) {
					placed.add(value.value);
				}
			}
			visit(node.children);
		}
	};
	visit(roots);
	if (walkedFiles.size === 0) {
		return undefined;
	}

	const missing = new Set<string>();
	for (const occurrence of inventory) {
		if (
			occurrence.value.kind === "static" &&
			occurrence.value.value !== undefined &&
			walkedFiles.has(occurrence.file) &&
			!placed.has(occurrence.value.value)
		) {
			missing.add(occurrence.value.value);
		}
	}
	if (missing.size === 0) {
		return undefined;
	}
	return {
		ids: [...missing].sort().slice(0, MAX_UNPLACED_IDS),
		total: missing.size,
	};
}
