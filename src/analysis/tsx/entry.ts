import { type SourceFile, SyntaxKind } from "ts-morph";
import { keyFold, matchesAnyGlob, normalizeRelPath } from "../util/paths";
import { resolveExportedName } from "../util/resolve";
import { isWorkspaceLocal } from "../util/workspaceRoot";
import type { Workspace } from "../workspace";
import {
	buildDefinition,
	type ComponentDefinition,
	resolveComponentRef,
} from "./componentGraph";
import type { TestIdTreeOptions } from "./tree";

/**
 * The rule this walk lives by, in one sentence:
 *
 * > **Walk what is syntactically ours; flag what placement we cannot prove;
 * > never drop anything silently.**
 *
 * What that means concretely.
 *
 * **Walked.** Direct JSX children of any element, including the children of a
 * component the walk cannot expand — `<Gapped><div data-tid="X"/></Gapped>` is
 * the caller's own source whatever `Gapped` turns out to be. JSX in the props
 * of a component element, including inside object literals and arrays. One hop
 * to a variable declared in the same component body, including a call with an
 * inline function argument, which is what makes `useMemo(() => <div/>)` work
 * with no `useMemo`-specific code. A *call* to a same-file function that
 * returns JSX — `{getCheckinIcon()}` — inlined at the call site; see
 * {@link TreeBuilder.renderHelperOf}. Conditionals, logical operators,
 * `.map`/`.flatMap` with an inline callback, fragments and type-assertion
 * wrappers.
 *
 * **Flagged, not followed.** Render props the callee invokes; `cloneElement`;
 * `Children.map`; a second variable hop; module-scope or imported JSX
 * constants; `.map(renderItem)` with a non-inline callback; JSX returned by a
 * helper in another file; JSX-valued props on *host* elements (React
 * stringifies those, so walking them would claim an id renders that never
 * does); namespaced tags. Each leaves a `#unresolved` marker node and
 * downgrades `fidelity` to `"partial"`.
 *
 * **Depth counts component-definition boundaries, not DOM nesting.** Slot and
 * prop children are walked at the caller's depth with no increment — they are
 * the caller's source — exactly as host-element children already are.
 */

/** Filenames an auto-detected entry may have, best first. */
const ENTRY_BASENAMES = ["main.tsx", "main.jsx", "index.tsx", "index.jsx"];

/**
 * Which scanned file, and which declaration inside it, a tree is rooted at.
 *
 * The caller names a component or a path; this turns that into one
 * `ComponentFunction`, or into the not-found answer that says what was
 * searched.
 */

/**
 * The caller's own scope filter, over workspace-relative paths.
 *
 * Shared with the post-walk inventory back-fill so the two cannot drift: a file
 * the caller scoped out must stay out of the inventory however the walk reached
 * it.
 */
export function scopeFilter(
	options: TestIdTreeOptions,
): (rel: string) => boolean {
	const include = options.include ?? [];
	const exclude = options.exclude ?? [];
	return (rel: string) => {
		if (include.length > 0 && !matchesAnyGlob(rel, include)) {
			return false;
		}
		return !(exclude.length > 0 && matchesAnyGlob(rel, exclude));
	};
}

export function selectFiles(
	ws: Workspace,
	options: TestIdTreeOptions,
): SourceFile[] {
	const inScope = scopeFilter(options);
	return ws.jsxFiles().filter((file) => inScope(ws.rel(file.getFilePath())));
}

/**
 * Workspace-relative paths an `entry` can name, in the order the walk searches
 * them.
 *
 * A caller that validates a user-supplied file before calling has to ask the
 * same question {@link findEntryComponent} asks, or the two drift and a path
 * one accepts is a path the other roots nothing at. Exported so nobody
 * re-derives "which files count as an entry" from the outside.
 */
export function entryFileCandidates(
	ws: Workspace,
	options: TestIdTreeOptions = {},
): string[] {
	return selectFiles(ws, options).map((file) => ws.rel(file.getFilePath()));
}

/** What {@link matchEntryPath} made of an `entry` against the scanned files. */
export type EntryPathMatch =
	| { kind: "exact" | "suffix"; file: string }
	| { kind: "ambiguous"; candidates: string[] }
	| { kind: "none" };

/**
 * The scanned path an `entry` names, out of {@link entryFileCandidates}.
 *
 * Exactness wins, always. A suffix is a convenience for `Nested.tsx` standing in
 * for `src/deep/Nested.tsx`, and letting it compete with the exact path in one
 * `.find()` pass handed the answer to whichever file sorted first: a monorepo
 * holding both `src/App.tsx` and `packages/ui/src/App.tsx` rooted the tree at
 * the package when the documented, fully-spelled path named the app. A suffix
 * that fits several files names none of them, and saying so beats picking one.
 *
 * Exported because a caller that validates a user-supplied path before calling
 * has to reach the same verdict this walk does. A second implementation of
 * "which scanned file is this?" outside the engine rewrote the request before
 * the rule below ever saw it, which put the monorepo bug back one layer up.
 */
export function matchEntryPath(
	candidates: readonly string[],
	entry: string,
): EntryPathMatch {
	const wanted = keyFold(normalizeRelPath(entry));
	const suffix: string[] = [];
	for (const rel of candidates) {
		const folded = keyFold(rel);
		if (folded === wanted) {
			return { kind: "exact", file: rel };
		}
		if (folded.endsWith(`/${wanted}`)) {
			suffix.push(rel);
		}
	}
	if (suffix.length === 1) {
		return { kind: "suffix", file: suffix[0] };
	}
	if (suffix.length > 1) {
		return { kind: "ambiguous", candidates: [...suffix].sort() };
	}
	return { kind: "none" };
}

function matchEntryFile(
	ws: Workspace,
	files: SourceFile[],
	entry: string,
):
	| { kind: "exact" | "suffix"; file: SourceFile }
	| { kind: "ambiguous"; candidates: string[] }
	| { kind: "none" } {
	const byRel = new Map<string, SourceFile>();
	for (const file of files) {
		byRel.set(ws.rel(file.getFilePath()), file);
	}
	const matched = matchEntryPath([...byRel.keys()], entry);
	if (matched.kind === "ambiguous" || matched.kind === "none") {
		return matched;
	}
	const file = byRel.get(matched.file);
	return file ? { kind: matched.kind, file } : { kind: "none" };
}

export function findEntryComponent(
	ws: Workspace,
	files: SourceFile[],
	options: TestIdTreeOptions,
): { definition: ComponentDefinition | null; reason?: string } {
	const resolveFrom = (
		sourceFile: SourceFile,
		tag: string,
	): ComponentDefinition | null => {
		const resolution = resolveComponentRef(ws, ws.project, sourceFile, tag, {
			preferSyntacticResolution: ws.options.preferSyntacticResolution ?? true,
		});
		return resolution.kind === "local" ? resolution.definition : null;
	};

	if (options.entry) {
		const matched = matchEntryFile(ws, files, options.entry);
		if (matched.kind === "none") {
			return {
				definition: null,
				reason: `Entry file "${options.entry}" was not found among the scanned files.`,
			};
		}
		if (matched.kind === "ambiguous") {
			return {
				definition: null,
				reason: `Entry file "${options.entry}" matches ${matched.candidates.length} scanned files (${matched.candidates.slice(0, 5).join(", ")}); pass the workspace-relative path.`,
			};
		}
		const target = matched.file;
		if (options.entryComponent) {
			const named = componentNamed(ws, target, options.entryComponent);
			if (named) {
				return { definition: named };
			}
			const declared = uppercaseDeclarationsIn(target);
			const alternatives =
				declared.length > 0
					? ` It declares ${declared.map((name) => `"${name}"`).join(", ")}.`
					: "";
			return {
				definition: null,
				reason: `Entry file "${options.entry}" does not declare a component named "${options.entryComponent}".${alternatives}`,
			};
		}
		const own = firstComponentIn(ws, target);
		if (own) {
			return { definition: own };
		}
		return {
			definition: null,
			reason: `Entry file "${options.entry}" does not declare a component.`,
		};
	}

	// Nothing is guessed for a bare `entryComponent`: searching every file for a
	// name would answer with whichever file was scanned first, and the caller
	// that knows the symbol always knows its file.
	if (options.entryComponent) {
		return {
			definition: null,
			reason: `entryComponent "${options.entryComponent}" needs an entry file; a component name is only unique within one file.`,
		};
	}

	// `main.tsx` renders the real root; follow the first local component it uses.
	const bootstraps = files
		.filter((file) => ENTRY_BASENAMES.includes(file.getBaseName()))
		.sort((a, b) => a.getFilePath().length - b.getFilePath().length);
	for (const bootstrap of bootstraps) {
		// Source order, not one kind then the other. `<Shell><App /></Shell>` has
		// `App` as a self-closing element and `Shell` as an opening one, so
		// concatenating the two lists picked the *child* as the root: the tree
		// came back rooted at `App` and everything `Shell` renders around it was
		// missing, with the nesting reported wrong rather than incomplete.
		const elements = [
			...bootstrap.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
			...bootstrap.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
		].sort((left, right) => left.getStart() - right.getStart());
		for (const element of elements) {
			const tag = element.getTagNameNode().getText();
			if (!/^[A-Z]/.test(tag)) {
				continue;
			}
			const definition = resolveFrom(bootstrap, tag);
			if (definition) {
				return { definition };
			}
		}
	}

	const app = files.find((file) =>
		/(^|\/)App\.[jt]sx$/.test(file.getFilePath()),
	);
	if (app) {
		const definition = firstComponentIn(ws, app);
		if (definition) {
			return { definition };
		}
	}

	return {
		definition: null,
		reason:
			"No entry could be auto-detected (looked for main/index bootstrap files and an App component).",
	};
}

/** Uppercase declarations a file offers, for a "did you mean" reason string. */
function uppercaseDeclarationsIn(sourceFile: SourceFile): string[] {
	const names = new Set<string>();
	for (const declaration of sourceFile.getFunctions()) {
		const name = declaration.getName();
		if (name && /^[A-Z]/.test(name)) {
			names.add(name);
		}
	}
	for (const declaration of sourceFile.getVariableDeclarations()) {
		const name = declaration.getName();
		if (/^[A-Z]/.test(name)) {
			names.add(name);
		}
	}
	return [...names].sort();
}

/**
 * The component a caller named explicitly, in the file they named it in.
 *
 * No uppercase filter anywhere: the caller wrote the name, so a lowercase one
 * is their business. The only rejection is `buildDefinition` refusing something
 * that is not a function component.
 */
function componentNamed(
	ws: Workspace,
	sourceFile: SourceFile,
	name: string,
): ComponentDefinition | null {
	// The default export first, and by the name it *reports*: `declaredNameOf`
	// gives an anonymous `export default () => …` the file's basename, so
	// `Foo.tsx` is addressable as "Foo" even though no declaration in it is
	// literally named that.
	const defaultExport = resolveExportedName(ws.project, sourceFile, "default");
	if (
		defaultExport &&
		isWorkspaceLocal(ws.project, defaultExport.sourceFile.getFilePath())
	) {
		const built = buildDefinition(
			ws,
			defaultExport.declaration,
			defaultExport.name,
		);
		if (built && built.name === name) {
			return built;
		}
	}

	const fn = sourceFile.getFunction(name);
	if (fn) {
		const built = buildDefinition(ws, fn, name);
		if (built) {
			return built;
		}
	}
	const variable = sourceFile.getVariableDeclaration(name);
	if (variable) {
		const built = buildDefinition(ws, variable, name);
		if (built) {
			return built;
		}
	}

	// A barrel `export { Beta } from "./Beta"` names a component this file does
	// not declare. It is keyed off the *declaring* file, exactly as the
	// default-export path documents in `firstComponentIn`.
	const exported = resolveExportedName(ws.project, sourceFile, name);
	if (
		exported &&
		isWorkspaceLocal(ws.project, exported.sourceFile.getFilePath())
	) {
		return buildDefinition(ws, exported.declaration, exported.name);
	}
	return null;
}

function firstComponentIn(
	ws: Workspace,
	sourceFile: SourceFile,
): ComponentDefinition | null {
	// The default export first, whether or not it has a name of its own:
	// `export default function () {}` and `export default () => …` are the only
	// component plenty of files declare, and skipping them dropped the whole tree
	// to a flat inventory that claimed the file declared nothing.
	//
	// The declaration is taken wherever the resolver found it, including another
	// file: `src/index.tsx` doing `export { default } from "./App"` is an
	// ordinary React entry point, and rejecting it because the declaration lives
	// in `App.tsx` dropped that entry to flat fidelity too. `buildDefinition`
	// keys the definition off the *declaring* file, so the root still comes back
	// as `src/App.tsx#default` — the same id `collectComponents` minted for it.
	// A declaration in an installed dependency is a boundary the scanner reports
	// rather than crosses, exactly as `resolveComponentRef` treats an imported
	// tag — and, just as there, a workspace package linked through
	// `node_modules` is not one.
	const defaultExport = resolveExportedName(ws.project, sourceFile, "default");
	if (
		defaultExport &&
		isWorkspaceLocal(ws.project, defaultExport.sourceFile.getFilePath())
	) {
		const built = buildDefinition(
			ws,
			defaultExport.declaration,
			defaultExport.name,
		);
		// A named default export still has to look like a component, so a file
		// whose default export is a lowercase helper keeps falling through to the
		// component loops below. An anonymous one has no name to judge.
		if (
			built &&
			(defaultExport.name === "default" || /^[A-Z]/.test(built.name))
		) {
			return built;
		}
	}
	for (const declaration of sourceFile.getFunctions()) {
		const name = declaration.getName();
		if (name && /^[A-Z]/.test(name)) {
			return buildLocal(ws, sourceFile, name);
		}
	}
	for (const declaration of sourceFile.getVariableDeclarations()) {
		const name = declaration.getName();
		if (/^[A-Z]/.test(name)) {
			const built = buildLocal(ws, sourceFile, name);
			if (built) {
				return built;
			}
		}
	}
	return null;
}

function buildLocal(
	ws: Workspace,
	sourceFile: SourceFile,
	name: string,
): ComponentDefinition | null {
	const resolution = resolveComponentRef(ws, ws.project, sourceFile, name, {
		preferSyntacticResolution: true,
	});
	return resolution.kind === "local" ? resolution.definition : null;
}
