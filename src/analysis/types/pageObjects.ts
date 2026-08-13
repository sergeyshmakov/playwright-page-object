/**
 * The shape of a page-object tree on the wire.
 *
 * Split out of `types.ts` on the section dividers it already carried. Every
 * name still reaches callers through `…/types`, which re-exports all three.
 */

import type { Diagnostic, MaybeStatic, SourceLoc } from "./index";

/* -------------------------------------------------------------------------- */
/* Selectors                                                                  */
/* -------------------------------------------------------------------------- */

export type SelectorKind =
	| "self"
	| "testId"
	| "testIdPattern"
	| "role"
	| "text"
	| "label"
	| "placeholder"
	| "altText"
	| "title"
	| "custom";

/**
 * A test-id pattern.
 *
 * `matchMode` mirrors the runtime: `@ListSelector("CartItem_")` compiles to
 * `new RegExp("CartItem_")`, which is **unanchored** — it matches `CartItem_1`
 * but also `XCartItem_1`. A `RegExp` literal keeps whatever anchors it declared.
 */
export interface PatternInfo {
	source: string;
	flags: string;
	origin: "string" | "regex";
	matchMode: "regexUnanchored" | "regex";
	/** Leading literal run of the pattern, used as a cheap containment probe. */
	literalPrefix: string | null;
}

export interface SelectorInfo {
	kind: SelectorKind;
	/** Canonical library export name, e.g. `"Selector"`, `"SelectorByRole"`. */
	decorator: string;
	/** Decorator source text, whitespace-collapsed, capped at 200 chars. */
	raw: string;
	dynamic: boolean;
	testId?: MaybeStatic;
	pattern?: PatternInfo;
	role?: MaybeStatic;
	text?: MaybeStatic;
	options?: MaybeStatic;
	args?: MaybeStatic[];
	notes?: string[];
}

/* -------------------------------------------------------------------------- */
/* Page objects                                                               */
/* -------------------------------------------------------------------------- */

export type MemberResult =
	| { kind: "locator" }
	| {
			kind: "pageObject";
			ref: string | null;
			className: string;
			external?: boolean;
	  }
	| {
			kind: "list";
			listClassName: string;
			listRef: string | null;
			itemClassName: string | null;
			itemRef: string | null;
			itemDefaulted?: boolean;
	  }
	| {
			kind: "control";
			ref: string | null;
			className: string | null;
			viaInlineFactory?: boolean;
			dynamic?: boolean;
	  }
	| { kind: "unknown"; dynamic: true; source: string };

export interface MemberNode {
	name: string;
	loc: SourceLoc;
	doc?: string;
	visibility: "public" | "protected" | "private";
	isStatic?: boolean;
	selector: SelectorInfo;
	result: MemberResult;
	warnings?: Diagnostic[];
}

export interface MethodInfo {
	name: string;
	kind: "method" | "getter" | "setter";
	signature: string;
	isAsync: boolean;
	/**
	 * `private` and `#private` members are never reported at all, so the only two
	 * states a listed method can be in are the two a test author can call.
	 */
	visibility: "public" | "protected";
	isStatic?: boolean;
	/** Declared on a project-local base class rather than on this one. */
	inherited?: true;
	/** Name of the class that declares it. Only set when {@link inherited}. */
	declaredIn?: string;
	/**
	 * Written as a class property holding a function (`run = async () => {}`)
	 * rather than with method syntax. It is callable all the same, but it is an
	 * own property, so it shadows rather than overrides.
	 */
	declaredAsProperty?: true;
	returnType: string | null;
	doc?: string;
	loc: SourceLoc;
}

export type HostKind =
	| "rootPageObject"
	| "rootPlain"
	| "pageFallback"
	| "fragment"
	| "nestedPageObject"
	| "externalControl"
	| "unknown";

export type HostScope = "body" | "root-selector" | "parent-locator" | "unknown";

export interface FixtureBinding {
	name: string;
	file: string;
	loc: SourceLoc;
	form: "constructor" | "factory" | "dynamic";
}

export interface PageObjectNode {
	id: string;
	className: string;
	file: string;
	loc: SourceLoc;
	hostKind: HostKind;
	scope: HostScope;
	rootSelector?: SelectorInfo;
	extendsChain: string[];
	inheritedApi: "PageObject" | "ListPageObject" | "RootPageObject" | null;
	ctorSignature?: string;
	doc?: string;
	fixtures?: FixtureBinding[];
	members: MemberNode[];
	methods: MethodInfo[];
	/** `false` when a depth or node budget stopped expansion. */
	expanded: boolean;
	/** `true` for synthetic stubs describing library-owned classes. */
	external?: boolean;
	warnings?: Diagnostic[];
}

export interface PageObjectTree {
	schemaVersion: 1;
	projectRoot: string;
	testIdAttribute: string;
	testIdAttributeSource: TestIdAttributeSource;
	/** Key into {@link defs}. */
	root: string;
	defs: Record<string, PageObjectNode>;
	warnings: Diagnostic[];
	truncated?: boolean;
	stats: {
		defs: number;
		members: number;
		methods: number;
		dynamic: number;
		parseMs: number;
	};
}

export type DiscoveryEvidence =
	| "decorator"
	| "baseClass"
	| "fixture"
	| "factoryArg";

export interface PageObjectSummary {
	id: string;
	className: string;
	file: string;
	loc: SourceLoc;
	hostKind: HostKind;
	scope: HostScope;
	rootSelector: SelectorInfo | null;
	extendsChain: string[];
	isExported: boolean;
	isDefaultExport: boolean;
	doc?: string;
	fixtures: FixtureBinding[];
	counts: { members: number; methods: number; dynamicMembers: number };
	discoveredBy: DiscoveryEvidence[];
	warnings: Diagnostic[];
}

export type TestIdAttributeSource = "playwright-config" | "default" | "param";

export interface PageObjectIndex {
	schemaVersion: 1;
	projectRoot: string;
	tsconfig: string | null;
	testIdAttribute: string;
	testIdAttributeSource: TestIdAttributeSource;
	pageObjects: PageObjectSummary[];
	warnings: Diagnostic[];
	stats: { filesScanned: number; parseMs: number; cached: boolean };
}
