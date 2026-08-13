/**
 * The shape of a rendered-UI tree on the wire.
 *
 * Split out of `types.ts` on the section dividers it already carried. Every
 * name still reaches callers through `…/types`, which re-exports all three.
 */

import type { Diagnostic, SourceLoc, TestIdValue } from "./index";
import type { TestIdAttributeSource } from "./pageObjects";

export type UiUnresolvedReason =
	/* component boundaries — the callee's own subtree is missing */
	| "external-module"
	| "identifier-unresolved"
	| "namespaced-component"
	| "not-a-function-component"
	/** The component renders itself on the current ancestor path; the walk cut the cycle. */
	| "recursive"
	/** The caller asked for one level only (`followComponents: false`). Not a budget cut. */
	| "not-followed"
	| "depth-limit-reached"
	| "node-budget-reached"
	/**
	 * A call to a same-file function that returns JSX — `{getCheckinIcon()}` — that
	 * the walk could not inline: it calls itself on this path, or its body produced
	 * no node. `raw` carries the call as written.
	 *
	 * Only ever emitted with positive evidence that the callee *is* a local render
	 * helper (a same-file arrow, function expression or function declaration whose
	 * body contains JSX). An ordinary call — `{t("label")}` — is not this, and gets
	 * no marker.
	 */
	| "local-render-function"
	/**
	 * The same shape one module away: `{renderRow()}` whose `renderRow` is
	 * imported from another file in this repository and returns JSX. Its subtree
	 * is not inlined — the nodes would be attributed to the caller's file, which
	 * is not where they are written — but the call is reported, because silence
	 * here left the ids it renders missing from the tree with `fidelity: "full"`
	 * over the top and `traversalGap` returning null.
	 *
	 * Held to the same evidence bar as `local-render-function`: the callee has to
	 * resolve to in-repo source whose body contains JSX. An imported `t("label")`
	 * is not this and gets no marker; neither does a call into a package, where
	 * nothing can tell the two apart.
	 */
	| "imported-render-function"
	/* content the walk could see but not place */
	/** The expression syntactically contains JSX the walk could not attach to a node. */
	| "unresolved-jsx"
	/** An expression that may render UI (a call, an unresolved identifier, a render prop). */
	| "opaque-expression"
	/* value-level, not structural */
	| "spread-props";

export interface UiNode {
	tag: string;
	/**
	 * `"unresolved"` is a synthetic marker node (`tag: "#unresolved"`) standing in
	 * for content the walk could see was there but could not resolve into nodes.
	 * It never has children and never carries a test id.
	 */
	nodeType: "element" | "component" | "branch" | "unresolved";
	testId?: TestIdValue;
	/**
	 * The other ids this one element renders, when its attribute writes a static
	 * choice: `data-testid={big ? "Main" : "Alt"}` and the same ternary spelled
	 * inside a template both render one of several ids, exactly one per render.
	 *
	 * `testId` holds the first branch and this holds the rest, so a reader that
	 * knows only `testId` still sees a real id — but every branch is here, and the
	 * node is `conditional`. Dropping them made the tree contradict the flat
	 * inventory, which has always carried one occurrence per branch: a selector
	 * for the second branch looked dead in the tree and alive in coverage.
	 */
	testIdAlternatives?: TestIdValue[];
	file: string;
	loc: SourceLoc;
	/** Enclosing component name at the declaration site. */
	component: string;
	conditional?: boolean;
	/** Rendered inside a `.map(...)` callback. */
	repeated?: boolean;
	componentRef?: string;
	/**
	 * Set on a component node whose subtree was already expanded at an earlier
	 * render site in this same tree, pointing at that site's `loc`. `children`
	 * holds only the nodes *this* site passed in as content — every one of them
	 * carries {@link UiNode.placement}. The component's own subtree was expanded
	 * at the referenced location; read the children there that have no
	 * `placement`. Only ever set when the two expansions would be identical.
	 */
	expandedAt?: SourceLoc;
	/**
	 * How this node reached its parent, when the parent is a component element.
	 *
	 * Absent means the ordinary case: the parent renders this node in the position
	 * the source shows. When present, the JSX is declared by the *caller* and was
	 * handed to the parent component as content — so it is the caller's own source
	 * and is walked as such, but **where, or whether, the parent renders it is not
	 * proven**. Read the subtree as "renders somewhere inside this component, or
	 * not at all".
	 *
	 * - `kind: "slot"` — passed as the parent's children (JSX between its tags, or
	 *   an explicit `children={…}` attribute).
	 * - `kind: "prop"` — passed as the value of another prop.
	 *
	 * `name` is `"children"` for a slot, otherwise the attribute name.
	 *
	 * Only the *top* node of each passed expression carries this. Its descendants
	 * have proven placement relative to their own parent.
	 */
	placement?: { kind: "slot" | "prop"; name: string };
	viaProp?: string;
	viaSpread?: boolean;
	/**
	 * The id came from the component's own fallback — a parameter default
	 * (`{ testId = "Row" }`) or a `prop || "Row"` / `prop ?? "Row"` expression —
	 * because the call site provably passed nothing. `viaProp` names the prop that
	 * was absent.
	 */
	viaDefault?: true;
	/**
	 * The element writes the test-id attribute, but at this render site the value
	 * provably resolves to nothing: it reads a prop the call site did not pass,
	 * the call site spreads nothing, and the prop declares no default. The
	 * attribute is absent from the DOM here — do not write a selector for it.
	 *
	 * Only ever set when the call site is known, so never on the tree root, whose
	 * caller is outside the analysed tree.
	 */
	testIdAbsent?: true;
	/**
	 * `raw` is the source text of what could not be resolved, collapsed to one
	 * line and truncated. Present only where the reason is about a specific
	 * expression the reader would otherwise have to go and find — a call to a
	 * local render helper names the helper — and absent where the reason already
	 * says everything (a depth limit, an external module).
	 */
	unresolved?: { reason: UiUnresolvedReason; raw?: string };
	children: UiNode[];
}

export interface TestIdOccurrence {
	value: TestIdValue;
	file: string;
	loc: SourceLoc;
	tag: string;
	component: string;
	conditional?: boolean;
	repeated?: boolean;
	viaProp?: string;
	/**
	 * How far the written attribute was proven to travel towards the DOM.
	 *
	 * - `"element"` — written directly on a host element. It renders.
	 * - `"forwarded"` — written as a prop somewhere, and the walk proved it lands
	 *   on a host element here. It renders.
	 * - `"component-prop"` — written on a *component* tag and nothing proved it
	 *   goes any further: `<Card data-testid="save"/>` renders that id only if
	 *   `Card` passes the prop to a host element, and a component that ignores it
	 *   makes the id disappear at runtime.
	 *
	 * The occurrence is kept in every case — it is a real fact about the source —
	 * but coverage counts only the first two as rendered. Required rather than
	 * optional on purpose: "the flag is absent" and "the reach is unknown" are
	 * not the same claim, and reading one as the other is what makes a coverage
	 * number confidently wrong.
	 */
	reach: "element" | "forwarded" | "component-prop";
}

export interface ComponentInfo {
	id: string;
	name: string;
	file: string;
	loc: SourceLoc;
	propNames: string[];
	forwardsSpread: boolean;
	exportKind: "default" | "named";
}

export interface TestIdTree {
	schemaVersion: 1;
	/** Reserved for future `"vue-sfc"` / `"svelte"` / `"angular-html"` scanners. */
	scanner: "jsx";
	attribute: string;
	attributeSource: TestIdAttributeSource;
	/**
	 * Completeness of the **node tree**, not of individual test ids.
	 *
	 * - `"full"` — the walk reached everything: no node carries a structural
	 *   `unresolved` reason and no budget cut fired.
	 * - `"partial"` — the walk ran, but at least one subtree is missing or its
	 *   placement is unproven. `roots` is real but has holes; `fidelityReason`
	 *   and `stats.unresolvedByReason` say where. Never treat the absence of a
	 *   test id in a partial tree as proof it is not rendered.
	 * - `"flat"` — no entry component could be rooted; `roots` is empty and only
	 *   `inventory` is meaningful.
	 *
	 * `inventory` is complete in all three states.
	 */
	fidelity: "full" | "partial" | "flat";
	/** Always present when `fidelity !== "full"`. */
	fidelityReason?: string;
	roots: UiNode[];
	/** Always complete across every scanned file, whatever the fidelity. */
	inventory: TestIdOccurrence[];
	components: Record<string, ComponentInfo>;
	/**
	 * Non-relative module specifiers that supply component tags the scan could
	 * not resolve to a file inside the workspace. Sorted, capped at 10.
	 *
	 * Evidence of *scope*, not of failure: a repository whose components come
	 * from a sibling package nobody put in scope renders test ids this scan can
	 * never see, and a coverage report that does not say so reads as proof those
	 * ids do not exist.
	 */
	externalModules: string[];
	/**
	 * How many distinct such specifiers there are, which is **not**
	 * `externalModules.length` once there are more than ten of them: that array
	 * is a display sample. Anything reporting a count must read this.
	 */
	externalModuleCount: number;
	/**
	 * External specifiers whose sources were found inside this repository — the
	 * only ones {@link externalModuleRoot} is derived from, and so the only ones
	 * anything may claim have sources here. Sorted and capped independently, so
	 * this is a subset of *all* external specifiers rather than of the
	 * `externalModules` sample: either list can omit an entry the other shows.
	 */
	linkedExternalModules: string[];
	/** How many are linked, for the same reason as {@link externalModuleCount}. */
	linkedExternalModuleCount: number;
	/**
	 * Directory to root an analysis at so those modules' sources come into scope,
	 * present only when at least one of them *has* sources here: a package linked
	 * into `node_modules` from elsewhere in the repository, which is the workspace
	 * monorepo shape. Absent when the tags come from installed packages or from
	 * specifiers that do not resolve, where no scope change can reach them.
	 *
	 * The distinction exists because the two cases take opposite advice, and one
	 * of them takes advice that cannot be followed: widening the scanned
	 * directories to a path outside the analysed root contributes nothing.
	 */
	externalModuleRoot?: string;
	warnings: Diagnostic[];
	truncated?: boolean;
	stats: {
		files: number;
		occurrences: number;
		dynamic: number;
		parseMs: number;
		/** Component tags resolved to one of {@link TestIdTree.externalModules}. */
		externalComponentTags: number;
		/** Nodes emitted into `roots`. */
		nodes: number;
		/**
		 * Nodes in `roots` carrying a structural `unresolved` reason — a subtree
		 * the walk could not produce. `spread-props` is excluded: it marks an
		 * unknown *value* on a node whose children are all present.
		 */
		unresolved: number;
		/**
		 * `unresolved` broken down by reason, counted over the same emitted nodes.
		 * Reasons that did not occur are omitted rather than reported as `0`, so
		 * the keys are exactly the holes this tree has.
		 *
		 * This is the machine-readable form of what `fidelityReason` says in
		 * prose; the prose is rendered from these counts, so the two cannot
		 * disagree.
		 */
		unresolvedByReason: Partial<Record<UiUnresolvedReason, number>>;
		/** Nodes carrying `placement` — content whose DOM position is unproven. */
		slots: number;
	};
}
