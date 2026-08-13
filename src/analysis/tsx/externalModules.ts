import * as path from "node:path";
import type { Node, Project, SourceFile } from "ts-morph";
import type { Diagnostic } from "../types";
import { isRelativeSpecifier, resolveModuleSpecifier } from "../util/resolve";
import {
	commonAncestorDirectory,
	isWorkspaceLocal,
	linkedOutsideRoot,
	packageSourceOutsideRoot,
} from "../util/workspaceRoot";
import type { Workspace } from "../workspace";
import type { ScannedElement } from "./scanTestIds";

/**
 * Which component tags resolve outside the analysed scan, and how loudly to
 * say so.
 *
 * A boundary is not a failure - a tag from `node_modules` renders ids this walk
 * cannot see, and the honest answer names the module rather than pretending the
 * subtree is empty. The census counts them so one diagnostic can stand for
 * many, and tells a monorepo apart from a real third-party dependency.
 */

/** Local binding name to module specifier, for non-relative imports only. */
function nonRelativeImportBindings(
	sourceFile: SourceFile,
): Map<string, string> {
	const bindings = new Map<string, string>();
	for (const declaration of sourceFile.getImportDeclarations()) {
		const specifier = declaration.getModuleSpecifierValue();
		if (isRelativeSpecifier(specifier)) {
			continue;
		}
		const defaultImport = declaration.getDefaultImport();
		if (defaultImport) {
			bindings.set(defaultImport.getText(), specifier);
		}
		const namespaceImport = declaration.getNamespaceImport();
		if (namespaceImport) {
			bindings.set(namespaceImport.getText(), specifier);
		}
		for (const named of declaration.getNamedImports()) {
			const local = named.getAliasNode() ?? named.getNameNode();
			bindings.set(local.getText(), specifier);
		}
	}
	return bindings;
}

/** Evidence that the scanned sources are not the whole UI. */
export interface ExternalModuleEvidence {
	/** Sorted, capped list of specifiers supplying component tags. */
	modules: string[];
	/**
	 * How many distinct specifiers there really are.
	 *
	 * Separate from `modules.length` because that is the length of a *display
	 * sample*. Reporting the sample's length as the count made the warning say
	 * "10 module(s)" on every repository with ten or more — saturating silently,
	 * so a reader sizing their blind spot on a 44-module app underestimated it
	 * more than four-fold. A capped list is fine; a capped number is a false
	 * statement.
	 */
	moduleCount: number;
	/**
	 * The subset of `modules` whose sources were found inside this repository,
	 * reached through a `node_modules` link — sorted and capped like `modules`.
	 *
	 * `sourceRoot` is computed from exactly these, so only these can be said to
	 * have sources here. The remedy sentence used to be written about every
	 * named module, which claimed an in-repo source for `@sentry/react`.
	 */
	linkedModules: string[];
	/** How many specifiers are linked, for the same reason as `moduleCount`. */
	linkedCount: number;
	/** Component tags whose head resolved to one of those modules. */
	tags: number;
	/**
	 * Where to root an analysis that would see those modules' sources, or `null`
	 * when none of them has sources to see.
	 *
	 * Non-null exactly when at least one specifier resolves through a
	 * `node_modules` link onto ordinary source outside the analysed root — the
	 * workspace-monorepo shape, where the sources are right there and the root is
	 * simply one package too deep. It is the deepest directory containing both
	 * the current root and those sources, which makes it the value to re-root at.
	 *
	 * `null` means the tags come from installed packages or from specifiers that
	 * do not resolve at all, and no scope change reaches them. The distinction is
	 * the whole point: advice to widen the scan is unfollowable in the first case
	 * (a scope outside the root contributes nothing) and impossible in the second.
	 */
	sourceRoot: string | null;
}

const MAX_EXTERNAL_MODULES = 10;

/** Workspace memo slot holding the shared "outside the workspace" answers. */
const CENSUS_CACHE_KEY = "external-module-census";

/** Separator that cannot occur in a path or in a module specifier. */
const CACHE_FIELD = "\u0000";

/**
 * Counts component tags rendered from modules outside the scanned sources.
 *
 * This is how the report tells "no page object selects this id" apart from
 * "the element rendering it is in a package nobody put in scope". In a monorepo
 * pointed at one app, whole design systems and sibling feature packages live
 * behind bare specifiers, their test ids are invisible, and every selector for
 * them looks dead. The count is not a diagnosis — a genuinely external `react`
 * import contributes nothing because `<div>` is not a component tag — but it is
 * the difference between a report that is wrong and one that says it might be.
 *
 * Non-relative specifiers only: a relative import is by construction a file the
 * scan either saw or deliberately scoped out, and `inventory-scope-gap` already
 * covers the latter.
 */
export class ExternalModuleCensus {
	private readonly modules = new Set<string>();
	/**
	 * Importing file plus specifier to "resolves outside the workspace", resolved
	 * at most once.
	 *
	 * The specifier alone is not the question being asked. `resolveModuleSpecifier`
	 * walks up from the *importing* file looking for `node_modules/<pkg>`, so in a
	 * monorepo where one package links `@acme/ui` to its own sources and another
	 * has an installed copy, one specifier has two answers and whichever file was
	 * scanned first decided for every other.
	 *
	 * Held on the workspace rather than on the census. A census is built per tree,
	 * and a session builds several — the scan-wide one, the entry-scoped one, the
	 * one coverage asks for — each of which was re-resolving every bare specifier
	 * in the repository from scratch. The answers are a property of the files, not
	 * of the tree being built, so they belong to the epoch: `Workspace.memo`
	 * hands the same map to every census until something invalidates it, and hands
	 * out a fresh one the moment anything does.
	 */
	private readonly outside: Map<string, ModulePlacement>;
	/** Real paths of external modules whose sources sit outside the root. */
	private readonly sourcePaths = new Set<string>();
	/** Specifiers behind those paths, so the remedy can name only them. */
	private readonly linked = new Set<string>();
	/**
	 * Every importing directory per specifier that resolved to no source.
	 *
	 * A set, not one directory. `packageSourceOutsideRoot` walks up from the
	 * *importer*, so in a monorepo where one package links `@acme/ui` to its own
	 * sources and another has an installed copy, the answer depends on which
	 * importer asks - the same reason {@link placementOf} keys on the file. One
	 * sample meant whichever file was scanned first decided for the whole
	 * repository, and a specifier could be reported as linked while the sources
	 * named beside it belong to a package nothing in that scope imports.
	 *
	 * Uncapped, because the numbers derived from it have to be true. See
	 * {@link add}.
	 */
	private readonly sampleDirs = new Map<string, Set<string>>();
	private tagCount = 0;

	constructor(private readonly ws: Workspace) {
		this.outside = ws.memo(
			CENSUS_CACHE_KEY,
			[],
			() => new Map<string, ModulePlacement>(),
		);
	}

	add(sourceFile: SourceFile, elements: ScannedElement[]): void {
		let bindings: Map<string, string> | undefined;
		for (const element of elements) {
			if (element.nodeType !== "component") {
				continue;
			}
			// Deferred: a file with no component tags never pays for the import walk.
			bindings ??= nonRelativeImportBindings(sourceFile);
			if (bindings.size === 0) {
				return;
			}
			const specifier = bindings.get(element.tag.split(".")[0]);
			if (specifier === undefined) {
				continue;
			}
			const placement = this.placementOf(sourceFile, specifier);
			if (!placement.outside) {
				continue;
			}
			this.tagCount += 1;
			this.modules.add(specifier);
			if (placement.sourcePath) {
				this.sourcePaths.add(placement.sourcePath);
				this.linked.add(specifier);
			} else {
				// Every distinct importing directory, not a sample. `linkedCount` and
				// `sourceRoot` are computed from what these probes find, and a capped
				// probe makes both of them lie - the count low, and the remedy's
				// common ancestor narrower than the sources it has to cover. "A
				// capped list is fine; a capped number is a false statement" applies
				// to this module's own output as much as to anything it reports.
				//
				// Directories, not files, so the set is a fraction of the repository
				// (1,621 for 4,924 files on the app this was measured against). Each
				// probe is memoized per (directory, package) and the `node_modules`
				// presence check per directory, so importers under a shared ancestor
				// cost map lookups rather than syscalls.
				let dirs = this.sampleDirs.get(specifier);
				if (!dirs) {
					dirs = new Set<string>();
					this.sampleDirs.set(specifier, dirs);
				}
				dirs.add(sourceFile.getDirectoryPath());
			}
		}
	}

	evidence(): ExternalModuleEvidence {
		const sources = new Set(this.sourcePaths);
		const linked = new Set(this.linked);
		// Deferred to here on purpose. This is the only filesystem walk the census
		// does, and doing it per (file, specifier) in `add` would run it thousands
		// of times on a monorepo; the answer it produces is one directory name for
		// one warning, so it is asked once per specifier that ended up external and
		// has no source yet — at most `MAX_EXTERNAL_MODULES` questions per tree,
		// memoized per epoch alongside the placements.
		for (const [specifier, directories] of this.sampleDirs) {
			const split = splitPackageName(specifier);
			if (!split) {
				continue;
			}
			for (const directory of directories) {
				// The importing directory is part of the key, not just the package
				// name. Without it one directory's answer was handed to every other
				// importer of the same package - so a specifier could be named as
				// linked on the strength of a probe from somewhere else entirely, and
				// `sourceRoot` widened to sources that scope never imports.
				const key = `${CACHE_FIELD}${DIAGNOSTIC_PREFIX}${CACHE_FIELD}${directory}${CACHE_FIELD}${split}`;
				let placement = this.outside.get(key);
				if (placement === undefined) {
					placement = {
						outside: true,
						sourcePath: packageSourceOutsideRoot(
							this.ws.project,
							directory,
							split,
						),
					};
					this.outside.set(key, placement);
				}
				if (placement.sourcePath) {
					sources.add(placement.sourcePath);
					linked.add(specifier);
				}
			}
		}
		return {
			modules: [...this.modules].sort().slice(0, MAX_EXTERNAL_MODULES),
			moduleCount: this.modules.size,
			linkedModules: [...linked].sort().slice(0, MAX_EXTERNAL_MODULES),
			linkedCount: linked.size,
			tags: this.tagCount,
			sourceRoot:
				sources.size === 0
					? null
					: commonAncestorDirectory([this.ws.root, ...sources]),
		};
	}

	private placementOf(
		fromFile: SourceFile,
		specifier: string,
	): ModulePlacement {
		const key = `${fromFile.getFilePath()}${CACHE_FIELD}${specifier}`;
		const cached = this.outside.get(key);
		if (cached !== undefined) {
			return cached;
		}
		let placement: ModulePlacement;
		try {
			const resolved = resolveModuleSpecifier(
				this.ws.project,
				fromFile,
				specifier,
			);
			if (resolved === undefined) {
				placement = OUTSIDE_UNRESOLVED;
			} else {
				const filePath = resolved.getFilePath();
				placement = isWorkspaceLocal(this.ws.project, filePath)
					? INSIDE
					: {
							outside: true,
							// Only a `node_modules` link onto source outside the root has a
							// directory worth naming; an installed package has none.
							sourcePath: linkedOutsideRoot(this.ws.project, filePath),
						};
			}
		} catch {
			placement = OUTSIDE_UNRESOLVED;
		}
		this.outside.set(key, placement);
		return placement;
	}
}

/** Where one specifier resolved, relative to the analysed workspace. */
interface ModulePlacement {
	outside: boolean;
	/** Real path of its source, when it is source this analysis could have read. */
	sourcePath: string | null;
}

const INSIDE: ModulePlacement = { outside: false, sourcePath: null };
const OUTSIDE_UNRESOLVED: ModulePlacement = { outside: true, sourcePath: null };

/** Cache-key namespace for the "where does this package really live" probe. */
const DIAGNOSTIC_PREFIX = "diagnostic";

/**
 * Package name of a bare specifier: `@scope/pkg` or `pkg`, subpath dropped.
 *
 * `null` for a relative or absolute specifier, which names no package and has
 * no `node_modules` directory to look for.
 */
function splitPackageName(specifier: string): string | null {
	if (specifier.startsWith(".") || specifier.startsWith("/")) {
		return null;
	}
	const segments = specifier.split("/");
	const spanned = segments[0].startsWith("@") ? 2 : 1;
	return segments.length < spanned
		? null
		: segments.slice(0, spanned).join("/");
}
