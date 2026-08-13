import { describe, expect, it } from "vitest";
import type { Diagnostic, UiNode, UiUnresolvedReason } from "../../../analysis";
import {
	blindScan,
	gapHint,
	subtreeStats,
	traversalGap,
} from "../../../mcp/present/gaps";

/**
 * The advice a partial tree gives about itself.
 *
 * Every one of these was previously reachable only by authoring a repository on
 * disk that made the analyser produce the shape under test — and for
 * {@link gapHint} that means a repository in which the wanted
 * `UiUnresolvedReason` is the *plurality* of boundaries, because
 * `traversalGap` picks its reason by count. Six of its seven arms had no test
 * at all, and its `default:` arm makes an unhandled reason invisible rather
 * than failing.
 */

/** A template hole in fixture *source*, assembled so it is not one here. */
const hole = (name: string): string => `\${${name}}`;

function node(overrides: Partial<UiNode> = {}): UiNode {
	return {
		tag: "div",
		nodeType: "element",
		file: "src/App.tsx",
		loc: { file: "src/App.tsx", line: 1 },
		component: "App",
		children: [],
		...overrides,
	} as UiNode;
}

/** `n` boundary markers carrying one reason, which is what the walk emits. */
function boundaries(reason: UiUnresolvedReason, count: number): UiNode[] {
	return Array.from({ length: count }, () =>
		node({
			nodeType: "unresolved",
			tag: "#unresolved",
			unresolved: { reason },
		}),
	);
}

describe("traversalGap", () => {
	it("returns null for a tree with nothing hidden", () => {
		expect(traversalGap([node(), node()], false)).toBeNull();
	});

	it("lets the caller's own choice win outright, however few", () => {
		// `not-followed` is the only reason the caller *chose*, so the fix is one
		// argument away and no count changes that.
		const gap = traversalGap(
			[...boundaries("not-followed", 1), ...boundaries("external-module", 50)],
			false,
		);
		expect(gap?.kind).toBe("not-followed");
	});

	it("picks the boundary reason by weight, not by rank", () => {
		// The production measurement this rule exists for: 49 depth-limited sites
		// against 178 external-module boundaries. Ranking first-hit told the reader
		// to raise depth — advice addressing 17% of the gap, which then cost 37%
		// more bytes and returned nothing.
		const gap = traversalGap(
			[
				...boundaries("depth-limit-reached", 49),
				...boundaries("external-module", 178),
			],
			false,
		);
		expect(gap?.kind).toBe("boundary");
		expect(gap?.reason).toBe("external-module");
	});

	it("prefers the depth cut when it outnumbers every boundary", () => {
		const gap = traversalGap(
			[
				...boundaries("depth-limit-reached", 40),
				...boundaries("external-module", 3),
			],
			false,
		);
		expect(gap?.kind).toBe("depth");
	});

	it("ignores spread-props, which hides no subtree", () => {
		// It marks an unknown test-id *value* on a node whose children are all
		// present — counting it would advertise a hole that is not there.
		expect(traversalGap(boundaries("spread-props", 5), false)).toBeNull();
	});

	it("reports an exhausted node budget", () => {
		expect(traversalGap([node()], true)?.kind).toBe("nodes");
	});
});

describe("gapHint", () => {
	const hint = (gap: Parameters<typeof gapHint>[0], depth = 4, follow = true) =>
		gapHint(gap, depth, follow);

	it("always carries the caveat, whatever the gap", () => {
		// "Absent from this tree" must never read as "not rendered".
		const caveat = "may still be rendered";
		for (const gap of [
			{ kind: "not-followed", detail: "" } as const,
			{ kind: "depth", detail: "" } as const,
			{ kind: "nodes", detail: "" } as const,
			{ kind: "boundary", detail: "", reason: "recursive" } as const,
		]) {
			expect(hint(gap), gap.kind).toContain(caveat);
		}
	});

	it("answers the depth gap differently depending on what is left to try", () => {
		const gap = { kind: "depth", detail: "" } as const;
		expect(hint(gap, 4, false)).toContain("followComponents: true");
		expect(hint(gap, 4, true)).toContain("larger depth");
		expect(hint(gap, 10, true)).toContain("already at the maximum");
	});

	it("gives each boundary reason its own answer", () => {
		const of = (reason: UiUnresolvedReason) =>
			hint({ kind: "boundary", detail: "", reason });
		// Only one of these is a budget, and the wrong advice costs a re-call that
		// cannot succeed.
		expect(of("external-module")).toContain("--project-root");
		expect(of("local-render-function")).toContain(
			"read that function directly",
		);
		expect(of("imported-render-function")).toContain("root a tree there");
		expect(of("recursive")).toContain("nothing to re-call with");
		for (const reason of [
			"identifier-unresolved",
			"namespaced-component",
			"not-a-function-component",
		] as const) {
			expect(of(reason), reason).toContain("do not resolve to a function");
		}
	});

	it("falls back to the bare caveat for a reason it has no advice for", () => {
		// The `default:` arm. Documenting it rather than asserting it is right:
		// an unhandled reason is silently generic here, which is why a new
		// `UiUnresolvedReason` needs a deliberate look at this switch.
		const bare = hint({
			kind: "boundary",
			detail: "",
			reason: "unresolved-jsx",
		});
		expect(bare).toContain("may still be rendered");
		expect(bare).not.toContain("Re-call");
	});
});

describe("subtreeStats", () => {
	it("counts the nodes actually shipped, by value kind", () => {
		const stats = subtreeStats([
			node({
				testId: { kind: "static", value: "A", raw: '"A"' },
				children: [
					node({
						testId: {
							kind: "pattern",
							regex: { source: "^A.+$", flags: "" },
							parts: [{ kind: "literal", text: "A" }],
							raw: `\`A${hole("n")}\``,
						},
					}),
					node({
						testId: {
							kind: "dynamic",
							reason: "computed-expression",
							raw: "id",
						},
					}),
					node(),
				],
			}),
		]);
		expect(stats).toMatchObject({
			nodes: 4,
			testIds: 3,
			patterns: 1,
			dynamic: 1,
			unresolved: 0,
		});
	});

	it("omits the reason breakdown on a complete tree", () => {
		// An empty object is noise; its absence and `unresolved: 0` say the same
		// thing once.
		expect(subtreeStats([node()])).not.toHaveProperty("unresolvedByReason");
	});

	it("breaks holes down by reason, excluding spread-props", () => {
		const stats = subtreeStats([
			...boundaries("external-module", 2),
			...boundaries("depth-limit-reached", 1),
			...boundaries("spread-props", 3),
		]);
		expect(stats.unresolved).toBe(3);
		expect(stats.unresolvedByReason).toEqual({
			"external-module": 2,
			"depth-limit-reached": 1,
		});
	});
});

describe("blindScan", () => {
	const mismatch = [
		{ code: "attribute-mismatch", severity: "warning", message: "" },
	] as Diagnostic[];
	const idLess = [node({ children: [node()] })];

	it("says nothing when the tree has ids", () => {
		const withId = [node({ testId: { kind: "static", value: "A", raw: "A" } })];
		expect(blindScan(mismatch, withId, null)).toBeUndefined();
	});

	it("says nothing about an empty tree, which is a different problem", () => {
		expect(blindScan(mismatch, [], null)).toBeUndefined();
	});

	it("names the attribute as the cause when the run read the wrong one", () => {
		const hint = blindScan(mismatch, idLess, null);
		expect(hint).toContain("attribute-mismatch");
		expect(hint).toContain("re-call");
	});

	it("blames the cut when the walk was incomplete", () => {
		const hint = blindScan([], idLess, {
			kind: "boundary",
			detail: "12 component tag(s) come from outside",
			reason: "external-module",
		});
		expect(hint).toContain("12 component tag(s)");
		expect(hint).toContain("testId");
	});

	it("stays quiet for a complete tree that simply renders no ids", () => {
		// Deliberate, and the opposite of the two cases above: "this component
		// renders none" is a real finding worth shipping. Only a *cut* tree with
		// no ids proves nothing.
		expect(blindScan([], idLess, null)).toBeUndefined();
	});
});

describe("a node-budget cut is not a component boundary", () => {
	/**
	 * The builder marks a budget cut on a component node, so counting it among
	 * the boundary reasons made it the widest one and returned the generic "left
	 * unexpanded" caveat. That hides the `nodes` gap underneath - the only one
	 * whose advice a caller can act on, because `maxNodes` is an argument they
	 * control and "a component was not expanded" is not.
	 */
	it("reports the nodes gap, not the boundary caveat", () => {
		const gap = traversalGap(
			[
				node({
					nodeType: "component",
					unresolved: { reason: "node-budget-reached" },
				}),
			],
			true,
		);
		expect(gap?.kind).toBe("nodes");
	});

	it("still reports a real boundary when one is present", () => {
		const gap = traversalGap(
			[
				node({
					nodeType: "component",
					unresolved: { reason: "external-module" },
				}),
			],
			true,
		);
		expect(gap?.kind).toBe("boundary");
	});
});
