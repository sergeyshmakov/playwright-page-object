import {
	type ClassDeclaration,
	type ClassMemberTypes,
	type Decorator,
	Node,
	type PropertyDeclaration,
	type SourceFile,
} from "ts-morph";
import { warn } from "../diagnostics";
import type { Diagnostic, MemberNode, MemberResult } from "../types";
import { docSummary } from "../util/jsdoc";
import { rawText } from "../util/literal";
import { defKey } from "../util/paths";
import {
	type NameRef,
	type RefResolution,
	readNameRef,
	resolveClassRef,
} from "../util/resolve";
import type { FactoryArg } from "./decoratorArgs";
import { readHeritage } from "./hostKind";
import {
	type AnalysisContext,
	canonicalDecoratorName,
	canonicalLocalName,
	collectLibraryImports,
	LIBRARY_BASE_CLASSES,
	LIBRARY_PACKAGE,
	type LibraryImports,
	MEMBER_DECORATORS,
} from "./libraryImports";
import { readSelector } from "./selectors";

/** Synthetic def key for a class owned by the library itself. */
export function libraryRef(name: string): string {
	return `${LIBRARY_PACKAGE}#${name}`;
}

export interface ClassRef {
	ref: string | null;
	className: string | null;
	declaration: ClassDeclaration | null;
	external: boolean;
	/**
	 * `true` when the name resolved to something constructable that is *not* a
	 * class - a function, or a variable holding one.
	 *
	 * Distinct from `declaration: null` with this unset, which means the walk
	 * lost the trail. That difference decides whether a `new X()` member gets
	 * the benefit of the doubt: an unfollowed chain might extend `PageObject`,
	 * while a resolved function provably does not.
	 */
	resolvedNonClass?: true;
}

/** Turns a resolution into a def key, without ever reading `node_modules`. */
export function refFromResolution(
	resolution: RefResolution | null,
	ctx: AnalysisContext,
	fallbackName?: string | null,
): ClassRef {
	if (!resolution) {
		return {
			ref: null,
			className: fallbackName ?? null,
			declaration: null,
			external: false,
		};
	}
	if (resolution.resolved) {
		const declaration = Node.isClassDeclaration(resolution.declaration)
			? resolution.declaration
			: null;
		// A class *expression* - `const Ctrl = class extends PageObject {}`, which
		// `hostKind` treats as a page object - is neither. It keeps the benefit of
		// the doubt below rather than being called a locator, because widening
		// `declaration` to `ClassLike` here would have to widen the whole
		// discovery pipeline with it. Known gap, deliberately not this change.
		const constructableNonClass =
			!declaration && !Node.isClassExpression(resolution.declaration);
		const name = declaration?.getName() ?? resolution.name;
		const file = ctx.ws.rel(resolution.sourceFile.getFilePath());
		return {
			ref: defKey(file, name),
			className: name,
			declaration,
			external: false,
			// Resolved, but not to a class at all: a constructable function, or a
			// variable holding one. Reachable in JavaScript and in TypeScript with
			// `noImplicitAny: false`.
			...(constructableNonClass ? { resolvedNonClass: true as const } : {}),
		};
	}
	if (resolution.external) {
		return {
			ref: `${resolution.module}#${resolution.name}`,
			className: resolution.name,
			declaration: null,
			external: true,
		};
	}
	return {
		ref: null,
		className: fallbackName ?? resolution.name,
		declaration: null,
		external: false,
	};
}

export interface MemberEdge {
	ref: string;
	className: string;
	declaration: ClassDeclaration | null;
	external: boolean;
	viaFactoryArg: boolean;
}

export interface MemberRead {
	member: MemberNode;
	edges: MemberEdge[];
	/**
	 * Declared on a project-local base class rather than on the class itself.
	 * The member is still part of the subclass's runtime surface; the flag keeps
	 * the base class's own diagnostics from being re-reported on every subclass.
	 */
	inherited?: boolean;
}

/**
 * A member's declared visibility, `#name` included.
 *
 * Shared with the method reader so a class's selectors and its methods can
 * never disagree about what "private" means on the same declaration.
 */
export function visibilityOf(
	member: ClassMemberTypes,
): MemberNode["visibility"] {
	const name = Node.hasName(member) ? member.getName() : "";
	if (typeof name === "string" && name.startsWith("#")) {
		return "private";
	}
	if (Node.isScoped(member) || Node.isScopeable(member)) {
		const scope = member.getScope();
		if (scope === "private" || scope === "protected") {
			return scope;
		}
	}
	return "public";
}

function isLibraryClassName(
	name: string,
	imports: LibraryImports,
	expected: string,
): boolean {
	return canonicalLocalName(name, imports) === expected;
}

function heritageApiOf(
	declaration: ClassDeclaration,
	ctx: AnalysisContext,
): string | null {
	const imports = collectLibraryImports(declaration.getSourceFile(), ctx);
	return readHeritage(declaration, imports, ctx).inheritedApi;
}

/**
 * Whether a resolved class *provably* extends no library page object.
 *
 * The runtime decides by `PageObject.isInstance` (`PageObject.ts:133`): a
 * `new X()` that is not one is not cloned, and the member evaluates to the bare
 * `Locator`. Reporting it as `pageObject` made `apiHints` promise `.$` and the
 * waits on a value that has neither — the tool confirming broken code rather
 * than catching it.
 *
 * "Provably" is the whole point. A chain the walk could not follow, or one that
 * hit the depth cap, is a gap in the analysis and not evidence about anyone's
 * code, so those keep the old benefit of the doubt.
 */
function provablyNotPageObject(
	declaration: ClassDeclaration,
	ctx: AnalysisContext,
): boolean {
	const imports = collectLibraryImports(declaration.getSourceFile(), ctx);
	const heritage = readHeritage(declaration, imports, ctx);
	return (
		heritage.inheritedApi === null &&
		!heritage.truncated &&
		!heritage.unresolvedBase
	);
}

function newExpressionClassName(node: Node): NameRef | null {
	if (!Node.isNewExpression(node)) {
		return null;
	}
	return readNameRef(node.getExpression());
}

function pushEdge(edges: MemberEdge[], ref: ClassRef, viaFactoryArg: boolean) {
	if (!ref.ref || !ref.className) {
		return;
	}
	edges.push({
		ref: ref.ref,
		className: ref.className,
		declaration: ref.declaration,
		external: ref.external,
		viaFactoryArg,
	});
}

/**
 * Decides what a decorated accessor actually evaluates to, mirroring
 * `getSelector` in `selectors.ts:39-56`: a `PageObject` instance is cloned with
 * the new context, a factory wraps the resolved locator, and everything else
 * falls through as the raw `Locator`.
 */
export function inferResult(
	property: PropertyDeclaration,
	factory: FactoryArg | null,
	imports: LibraryImports,
	ctx: AnalysisContext,
): { result: MemberResult; edges: MemberEdge[]; warnings: Diagnostic[] } {
	const edges: MemberEdge[] = [];
	const warnings: Diagnostic[] = [];

	if (factory) {
		const ref = refFromResolution(factory.resolution, ctx, factory.className);
		pushEdge(edges, ref, true);
		const result: MemberResult = {
			kind: "control",
			ref: ref.ref,
			className: factory.className,
		};
		if (factory.viaInlineFactory) {
			result.viaInlineFactory = true;
		}
		if (factory.dynamic) {
			result.dynamic = true;
		}
		return { result, edges, warnings };
	}

	const initializer = property.getInitializer();
	const newClassName = initializer ? newExpressionClassName(initializer) : null;

	if (initializer && newClassName && Node.isNewExpression(initializer)) {
		const sourceFile = property.getSourceFile();
		const isLibraryList = isLibraryClassName(
			newClassName.qualified,
			imports,
			"ListPageObject",
		);
		const resolution = isLibraryList
			? null
			: resolveClassRef(
					ctx.project,
					sourceFile,
					newClassName.qualified,
					ctx.resolveOptions,
				);
		const listRef: ClassRef = isLibraryList
			? {
					ref: libraryRef("ListPageObject"),
					className: "ListPageObject",
					declaration: null,
					external: true,
				}
			: refFromResolution(resolution, ctx, newClassName.simple);

		const isUserList =
			!isLibraryList &&
			!!listRef.declaration &&
			heritageApiOf(listRef.declaration, ctx) === "ListPageObject";

		if (isLibraryList || isUserList) {
			pushEdge(edges, listRef, false);
			const itemArgument = initializer.getArguments()[0];
			const item = readListItem(itemArgument, imports, ctx, sourceFile);
			if (item.ref) {
				pushEdge(edges, item.ref, false);
			}
			const result: MemberResult = {
				kind: "list",
				listClassName: listRef.className ?? newClassName.simple,
				listRef: listRef.ref,
				itemClassName: item.ref?.className ?? null,
				itemRef: item.ref?.ref ?? null,
			};
			if (item.defaulted) {
				result.itemDefaulted = true;
			}
			return { result, edges, warnings };
		}

		// Any other `new X()` where X is a PageObject subclass, or the library
		// PageObject itself.
		const isLibraryPageObject =
			isLibraryClassName(newClassName.qualified, imports, "PageObject") ||
			isLibraryClassName(newClassName.qualified, imports, "RootPageObject");
		if (isLibraryPageObject) {
			const canonical =
				canonicalLocalName(newClassName.qualified, imports) ?? "PageObject";
			return {
				result: {
					kind: "pageObject",
					ref: libraryRef(canonical),
					className: canonical,
					external: true,
				},
				edges: [
					{
						ref: libraryRef(canonical),
						className: canonical,
						declaration: null,
						external: true,
						viaFactoryArg: false,
					},
				],
				warnings,
			};
		}
		// Something we resolved that provably has none of the library's API: the
		// runtime's `getSelector` clones a PageObject instance and lets everything
		// else fall through as the raw Locator, so that is what this member is.
		// Calling it a page object makes `apiHints` promise `.$` and the waits on
		// a value that has neither.
		//
		// Two ways to be sure. A class whose heritage reaches no library base, and
		// a resolved non-class - `new Widget()` where `Widget` is a function -
		// which cannot extend anything at all. The second used to slip through
		// because a non-class resolution carries no `declaration` to test, and an
		// absent declaration read as "the walk lost the trail", which is the one
		// case that keeps the benefit of the doubt.
		if (
			listRef.resolvedNonClass ||
			(listRef.declaration && provablyNotPageObject(listRef.declaration, ctx))
		) {
			return { result: { kind: "locator" }, edges, warnings };
		}
		pushEdge(edges, listRef, false);
		return {
			result: {
				kind: "pageObject",
				ref: listRef.ref,
				className: listRef.className ?? newClassName.simple,
			},
			edges,
			warnings,
		};
	}

	const typeNode = property.getTypeNode();
	if (typeNode) {
		const typeText = typeNode.getText();
		if (/^Locator(\s*\|\s*undefined)?$/.test(typeText.trim())) {
			return { result: { kind: "locator" }, edges, warnings };
		}
		// A qualified `po.PageObject` annotation counts too.
		const bareName = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/.exec(
			typeText.trim(),
		)?.[1];
		if (bareName && bareName !== "Locator") {
			const isLibraryBase = LIBRARY_BASE_CLASSES.has(
				canonicalLocalName(bareName, imports) ?? "",
			);
			const resolution = resolveClassRef(
				ctx.project,
				property.getSourceFile(),
				bareName,
				ctx.resolveOptions,
			);
			if (isLibraryBase || resolution.resolved) {
				// Runtime returns a raw Locator here: there is no initializer to
				// clone and no factory to call, so the annotation lies.
				warnings.push(
					warn(
						"type-annotation-mismatch",
						`"${property.getName()}" is annotated as \`${typeText}\` but has no initializer and no factory argument, so the decorator returns a raw Locator at runtime.`,
						ctx.ws.loc(typeNode),
					),
				);
				return { result: { kind: "locator" }, edges, warnings };
			}
		}
		return { result: { kind: "locator" }, edges, warnings };
	}

	return {
		result: {
			kind: "unknown",
			dynamic: true,
			source: rawText(property, 120),
		},
		edges,
		warnings,
	};
}

function readListItem(
	itemArgument: Node | undefined,
	imports: LibraryImports,
	ctx: AnalysisContext,
	sourceFile: SourceFile,
): { ref: ClassRef | null; defaulted: boolean } {
	if (!itemArgument) {
		return {
			ref: {
				ref: libraryRef("PageObject"),
				className: "PageObject",
				declaration: null,
				external: true,
			},
			defaulted: true,
		};
	}

	const name = Node.isNewExpression(itemArgument)
		? newExpressionClassName(itemArgument)
		: readNameRef(itemArgument);

	if (!name) {
		return { ref: null, defaulted: false };
	}
	const canonical = canonicalLocalName(name.qualified, imports);
	if (canonical && LIBRARY_BASE_CLASSES.has(canonical)) {
		return {
			ref: {
				ref: libraryRef(canonical),
				className: canonical,
				declaration: null,
				external: true,
			},
			defaulted: false,
		};
	}
	const resolution = resolveClassRef(
		ctx.project,
		sourceFile,
		name.qualified,
		ctx.resolveOptions,
	);
	return {
		ref: refFromResolution(resolution, ctx, name.simple),
		defaulted: false,
	};
}

/** The library selector decorator on a class member, if there is one. */
export function findSelectorDecorator(
	member: ClassMemberTypes,
	imports: LibraryImports,
): { decorator: Decorator; name: string } | undefined {
	if (!Node.isDecoratable(member)) {
		return undefined;
	}
	for (const decorator of member.getDecorators()) {
		const canonical = canonicalDecoratorName(decorator, imports);
		if (canonical && MEMBER_DECORATORS.has(canonical)) {
			return { decorator, name: canonical };
		}
	}
	return undefined;
}

/**
 * Reads one decorated class member.
 *
 * Returns `null` for members that carry no library decorator. Members that
 * carry one in an unsupported position (a plain field, a getter) are still
 * returned, with a diagnostic — the runtime throws for those, and silently
 * dropping them would hide the bug.
 */
export function readMember(
	member: ClassMemberTypes,
	imports: LibraryImports,
	ctx: AnalysisContext,
): MemberRead | null {
	const found = findSelectorDecorator(member, imports);
	if (!found) {
		return null;
	}

	const warnings: Diagnostic[] = [];
	const isAccessorProperty =
		Node.isPropertyDeclaration(member) && member.hasAccessorKeyword();

	if (!isAccessorProperty) {
		warnings.push(
			warn(
				"decorator-on-non-accessor",
				`@${found.name} must decorate an \`accessor\` class element; the decorator throws at class definition time otherwise (selectorBy.ts:122).`,
				ctx.ws.loc(found.decorator),
			),
		);
	}

	const {
		selector,
		split,
		warnings: selectorWarnings,
	} = readSelector(found.decorator, found.name, imports, ctx);
	warnings.push(...selectorWarnings);

	let result: MemberResult;
	let edges: MemberEdge[] = [];
	if (Node.isPropertyDeclaration(member)) {
		const inferred = inferResult(member, split.factory, imports, ctx);
		result = inferred.result;
		edges = inferred.edges;
		warnings.push(...inferred.warnings);
	} else {
		result = {
			kind: "unknown",
			dynamic: true,
			source: rawText(member, 120),
		};
	}

	const name = Node.hasName(member) ? String(member.getName()) : "(unnamed)";
	const node: MemberNode = {
		name,
		loc: ctx.ws.loc(member),
		visibility: visibilityOf(member),
		selector,
		result,
	};
	const doc = docSummary(member);
	if (doc) {
		node.doc = doc;
	}
	if (Node.isStaticable(member) && member.isStatic()) {
		node.isStatic = true;
	}
	if (warnings.length > 0) {
		node.warnings = warnings;
	}

	return { member: node, edges };
}
