import { type ClassDeclaration, Node, type SourceFile } from "ts-morph";
import { dedupeDiagnostics } from "../diagnostics";
import type {
	Diagnostic,
	DiscoveryEvidence,
	MethodInfo,
	PageObjectIndex,
	PageObjectSummary,
	SelectorInfo,
	SourceLoc,
} from "../types";
import { isDefaultExported, isExported } from "../util/exports";
import { docSummary } from "../util/jsdoc";
import { defKey, keyFold, matchesAnyGlob, toPosix } from "../util/paths";
import { lineAt } from "../util/position";
import type { Workspace } from "../workspace";
import { type FixtureMap, readFixtureMaps } from "./fixtures";
import {
	type ClassLike,
	classifyHost,
	findRootDecorator,
	type HostClassification,
	hasDecoratedMembers,
	readHeritage,
} from "./hostKind";
import {
	type AnalysisContext,
	collectLibraryImports,
	createAnalysisContext,
	type LibraryImports,
} from "./libraryImports";
import { type MemberRead, readMember } from "./members";
import { readMethods } from "./methods";
import { readRootSelector } from "./selectors";

export interface DiscoverOptions {
	include?: string[];
	exclude?: string[];
	/** Include classes only reachable as `@Selector(..., Ctrl)` factory arguments. */
	includeControls?: boolean;
	signatureMode?: "syntactic" | "checked";
}

export interface DiscoveredClass {
	key: string;
	foldedKey: string;
	className: string;
	file: string;
	declaration: ClassDeclaration;
	imports: LibraryImports;
	evidence: Set<DiscoveryEvidence>;
	classification: HostClassification;
	rootSelector: SelectorInfo | null;
	/** Where the root decorator is written. Absent when there is no root selector. */
	rootSelectorLoc?: SourceLoc;
	members: MemberRead[];
	methods: MethodInfo[];
	warnings: Diagnostic[];
	/** Guard so the D4 fixpoint loop reads each class's members exactly once. */
	membersRead?: boolean;
}

export interface DiscoveryResult {
	index: PageObjectIndex;
	/** Case-folded def key to the discovered class. */
	classes: Map<string, DiscoveredClass>;
	byName: Map<string, DiscoveredClass[]>;
	fixtures: FixtureMap;
	ctx: AnalysisContext;
}

const MAX_FACTORY_ROUNDS = 6;

/**
 * Every decorated member the class exposes at runtime: its own, plus those it
 * inherits from project-local base classes.
 *
 * A decorated `accessor` installs a get/set pair on the prototype, so a
 * subclass really does expose its base's selectors — reporting only the
 * subclass's own members made `counts.members` wrong and hid inherited
 * selectors from the tree, which is how an agent ends up re-declaring one that
 * already exists.
 *
 * Override semantics are by name, nearest class first: anything the subclass
 * declares — decorated or not — shadows the base member of the same name,
 * exactly as the prototype chain does.
 */
function collectMembers(
	entry: DiscoveredClass,
	ctx: AnalysisContext,
): MemberRead[] {
	const out: MemberRead[] = [];
	const shadowed = new Set<string>();

	const collect = (
		declaration: ClassLike,
		imports: LibraryImports,
		inherited: boolean,
	) => {
		const declaredHere: string[] = [];
		for (const member of declaration.getMembers()) {
			const name = Node.hasName(member) ? String(member.getName()) : "";
			if (name !== "") {
				declaredHere.push(name);
				if (shadowed.has(name)) {
					continue;
				}
			}
			const read = readMember(member, imports, ctx);
			if (read) {
				out.push(inherited ? { ...read, inherited: true } : read);
			}
		}
		for (const name of declaredHere) {
			shadowed.add(name);
		}
	};

	collect(entry.declaration, entry.imports, false);
	for (const base of readHeritage(entry.declaration, entry.imports, ctx)
		.localBases) {
		collect(base, collectLibraryImports(base.getSourceFile(), ctx), true);
	}
	return out;
}

function selectFiles(ws: Workspace, options: DiscoverOptions): SourceFile[] {
	const include = options.include ?? [];
	const exclude = options.exclude ?? [];
	return ws.sourceFiles().filter((file) => {
		const rel = ws.rel(file.getFilePath());
		if (include.length > 0 && !matchesAnyGlob(rel, include)) {
			return false;
		}
		if (exclude.length > 0 && matchesAnyGlob(rel, exclude)) {
			return false;
		}
		return true;
	});
}

function groupRank(entry: DiscoveredClass, fixtureCount: number): number {
	if (fixtureCount > 0) {
		return 0;
	}
	switch (entry.classification.hostKind) {
		case "rootPageObject":
		case "rootPlain":
		case "pageFallback":
			return 1;
		case "nestedPageObject":
		case "fragment":
			return 2;
		default:
			return 3;
	}
}

function buildEntry(
	declaration: ClassDeclaration,
	imports: LibraryImports,
	ctx: AnalysisContext,
	evidence: DiscoveryEvidence,
): DiscoveredClass | null {
	const className = declaration.getName();
	if (!className) {
		return null;
	}
	const file = ctx.ws.rel(declaration.getSourceFile().getFilePath());
	const key = defKey(file, className);
	return {
		key,
		foldedKey: keyFold(key),
		className,
		file,
		declaration,
		imports,
		evidence: new Set<DiscoveryEvidence>([evidence]),
		classification: {
			hostKind: "unknown",
			scope: "unknown",
			heritage: {
				chain: [],
				inheritedApi: null,
				localBases: [],
				truncated: false,
			},
			rootDecorator: null,
			warnings: [],
		},
		rootSelector: null,
		members: [],
		methods: [],
		warnings: [],
	};
}

/**
 * Finds every page object in the workspace.
 *
 * Four independent rules feed one registry: a library decorator (D1), a
 * library base class reached transitively (D2), a `createFixtures` binding
 * (D3), and — last, because it depends on the others — being referenced as a
 * factory argument or list item type (D4). Evidence merges into a single
 * entry rather than producing duplicates.
 */
export function runDiscovery(
	ws: Workspace,
	options: DiscoverOptions = {},
): DiscoveryResult {
	const startedAt = Date.now();
	const ctx = createAnalysisContext(ws);
	const files = selectFiles(ws, options);
	const classes = new Map<string, DiscoveredClass>();
	// Before the snapshot below, not after it: reading the config is what parses
	// `playwright.config.*`, and its notes (an unresolvable `testIdAttribute`, an
	// unresolvable `testDir`, an unrecognised config shape) land in
	// `ws.warnings`. Taken the other way round the snapshot predates them and
	// this index — the only payload that carries workspace warnings — silently
	// drops every one.
	//
	// `ws.playwright()` rather than `ws.testIdAttribute()` alone, because an
	// explicit `attribute` option short-circuits the attribute read before it
	// reaches the config: the override decides which attribute wins, never
	// whether the config is read. Both go through the same per-epoch memo, so
	// this is one parse either way.
	ws.playwright();
	const attribute = ws.testIdAttribute();
	const warnings: Diagnostic[] = [
		...ws.environmentWarnings(attribute.attribute),
	];

	const register = (
		declaration: ClassDeclaration,
		imports: LibraryImports,
		evidence: DiscoveryEvidence,
	): DiscoveredClass | null => {
		const className = declaration.getName();
		if (!className) {
			return null;
		}
		const file = ctx.ws.rel(declaration.getSourceFile().getFilePath());
		const folded = keyFold(defKey(file, className));
		const existing = classes.get(folded);
		if (existing) {
			existing.evidence.add(evidence);
			return existing;
		}
		const entry = buildEntry(declaration, imports, ctx, evidence);
		if (entry) {
			classes.set(entry.foldedKey, entry);
		}
		return entry;
	};

	// D1 + D2.
	for (const sourceFile of files) {
		const imports = collectLibraryImports(sourceFile, ctx);
		for (const declaration of sourceFile.getClasses()) {
			const decorated =
				imports.hasAny &&
				(findRootDecorator(declaration, imports) !== undefined ||
					hasDecoratedMembers(declaration, imports));
			if (decorated) {
				register(declaration, imports, "decorator");
			}
			if (declaration.getExtends()) {
				const heritage = readHeritage(declaration, imports, ctx);
				if (heritage.inheritedApi !== null) {
					register(declaration, imports, "baseClass");
				}
			}
		}
	}

	// D3.
	const fixtures = readFixtureMaps(files, ctx);
	warnings.push(...fixtures.warnings);
	for (const [folded, declaration] of fixtures.declarations) {
		const existing = classes.get(folded);
		if (existing) {
			existing.evidence.add("fixture");
			continue;
		}
		register(
			declaration,
			collectLibraryImports(declaration.getSourceFile(), ctx),
			"fixture",
		);
	}

	// D4 — repeat until no new control classes appear.
	const factoryArgKeys = new Set<string>();
	for (let round = 0; round < MAX_FACTORY_ROUNDS; round += 1) {
		const pending = [...classes.values()].filter(
			(entry) => entry.members.length === 0 && !entry.membersRead,
		);
		if (pending.length === 0) {
			break;
		}
		let added = false;
		for (const entry of pending) {
			entry.membersRead = true;
			for (const read of collectMembers(entry, ctx)) {
				entry.members.push(read);
				for (const edge of read.edges) {
					if (edge.viaFactoryArg) {
						factoryArgKeys.add(keyFold(edge.ref));
					}
					if (!edge.declaration) {
						continue;
					}
					const before = classes.size;
					register(
						edge.declaration,
						collectLibraryImports(edge.declaration.getSourceFile(), ctx),
						"factoryArg",
					);
					if (classes.size !== before) {
						added = true;
					}
				}
			}
		}
		if (!added) {
			break;
		}
	}

	// Classification and per-class surface, now that factory-arg roles are known.
	for (const entry of classes.values()) {
		entry.classification = classifyHost(entry.declaration, entry.imports, ctx, {
			referencedAsFactoryArg: factoryArgKeys.has(entry.foldedKey),
		});
		entry.warnings.push(...entry.classification.warnings);
		const rootDecorator = entry.classification.rootDecorator;
		if (rootDecorator) {
			const read = readRootSelector(
				rootDecorator.decorator,
				rootDecorator.name,
				entry.imports,
				ctx,
			);
			entry.rootSelector = read.selector;
			// Coverage reports a matched root selector at this location. Without it
			// the entry shipped `line: 0`, which is not a line — an agent following
			// it lands nowhere.
			entry.rootSelectorLoc = {
				file: entry.file,
				line: lineAt(
					rootDecorator.decorator.getSourceFile(),
					rootDecorator.decorator.getStart(),
				),
			};
			entry.warnings.push(...read.warnings);
		}
		// Explicit, not defaulted: `counts.methods` here and the method list in
		// `get_page_object_tree` have to be the same number, and the two call
		// sites drifting apart is exactly how they stopped being one.
		entry.methods = readMethods(entry.declaration, entry.imports, ctx, {
			signatureMode: options.signatureMode,
			includeInherited: true,
		});
		for (const member of entry.members) {
			// An inherited member's diagnostics belong to the base class that
			// declares it, and it is discovered in its own right.
			if (member.member.warnings && !member.inherited) {
				entry.warnings.push(...member.member.warnings);
			}
		}
	}

	warnings.push(...ctx.warnings);

	const byName = new Map<string, DiscoveredClass[]>();
	for (const entry of classes.values()) {
		const list = byName.get(entry.className);
		if (list) {
			list.push(entry);
		} else {
			byName.set(entry.className, [entry]);
		}
	}

	const includeControls = options.includeControls ?? false;
	const summaries: PageObjectSummary[] = [];
	for (const entry of classes.values()) {
		const bindings = fixtures.byClass.get(entry.foldedKey) ?? [];
		const onlyFactoryArg =
			entry.evidence.size === 1 && entry.evidence.has("factoryArg");
		if (onlyFactoryArg && !includeControls) {
			continue;
		}
		summaries.push(toSummary(entry, bindings));
	}

	summaries.sort((a, b) => {
		const entryA = classes.get(keyFold(a.id));
		const entryB = classes.get(keyFold(b.id));
		const rankA = entryA ? groupRank(entryA, a.fixtures.length) : 3;
		const rankB = entryB ? groupRank(entryB, b.fixtures.length) : 3;
		if (rankA !== rankB) {
			return rankA - rankB;
		}
		if (a.className !== b.className) {
			return a.className < b.className ? -1 : 1;
		}
		return a.file < b.file ? -1 : 1;
	});

	const index: PageObjectIndex = {
		schemaVersion: 1,
		projectRoot: toPosix(ws.root),
		tsconfig: ws.tsconfigPath ? ws.rel(ws.tsconfigPath) : null,
		testIdAttribute: attribute.attribute,
		testIdAttributeSource: attribute.source,
		pageObjects: summaries,
		warnings: dedupeDiagnostics(warnings),
		stats: {
			filesScanned: files.length,
			parseMs: Date.now() - startedAt,
			cached: false,
		},
	};

	return { index, classes, byName, fixtures, ctx };
}

function toSummary(
	entry: DiscoveredClass,
	fixtures: PageObjectSummary["fixtures"],
): PageObjectSummary {
	let dynamicMembers = 0;
	for (const member of entry.members) {
		if (
			member.member.selector.dynamic ||
			member.member.result.kind === "unknown" ||
			(member.member.result.kind === "control" && member.member.result.dynamic)
		) {
			dynamicMembers += 1;
		}
	}

	const summary: PageObjectSummary = {
		id: entry.key,
		className: entry.className,
		file: entry.file,
		loc: { file: entry.file, line: locLine(entry) },
		hostKind: entry.classification.hostKind,
		scope: entry.classification.scope,
		rootSelector: entry.rootSelector,
		extendsChain: entry.classification.heritage.chain,
		isExported: isExported(entry.declaration),
		isDefaultExport: isDefaultExported(entry.declaration),
		fixtures,
		counts: {
			members: entry.members.length,
			methods: entry.methods.length,
			dynamicMembers,
		},
		discoveredBy: [...entry.evidence].sort(),
		warnings: dedupeDiagnostics(entry.warnings),
	};
	const doc = docSummary(entry.declaration);
	if (doc) {
		summary.doc = doc;
	}
	return summary;
}

function locLine(entry: DiscoveredClass): number {
	return lineAt(
		entry.declaration.getSourceFile(),
		entry.declaration.getStart(),
	);
}

/**
 * Public entry point: `list_page_objects`.
 *
 * The index is copied on the way out so the `cached` flag reflects *this* call
 * rather than mutating the memoized object other callers hold.
 */
export function discoverPageObjects(
	ws: Workspace,
	options: DiscoverOptions = {},
): PageObjectIndex {
	const { result, fresh } = discoverCached(ws, options);
	return {
		...result.index,
		stats: { ...result.index.stats, cached: !fresh },
	};
}

/** Shared, memoized discovery used by the tree and coverage builders. */
export function discoverInternal(
	ws: Workspace,
	options: DiscoverOptions = {},
): DiscoveryResult {
	return discoverCached(ws, options).result;
}

function discoverCached(
	ws: Workspace,
	options: DiscoverOptions,
): { result: DiscoveryResult; fresh: boolean } {
	const key = `discover::${JSON.stringify({
		include: options.include ?? null,
		exclude: options.exclude ?? null,
		includeControls: options.includeControls ?? false,
		signatureMode: options.signatureMode ?? "syntactic",
	})}`;
	let fresh = false;
	const result = ws.memo(key, [], () => {
		fresh = true;
		return runDiscovery(ws, options);
	});
	return { result, fresh };
}
