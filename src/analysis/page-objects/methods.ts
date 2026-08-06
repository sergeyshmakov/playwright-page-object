import {
	type ArrowFunction,
	type ClassDeclaration,
	type ClassMemberTypes,
	type FunctionExpression,
	Node,
} from "ts-morph";
import type { MethodInfo } from "../types";
import { docSummary } from "../util/jsdoc";
import {
	renderAccessor,
	renderFunctionProperty,
	renderFunctionReturnType,
	renderMethod,
	renderReturnType,
	type SignatureMode,
} from "../util/signature";
import { type ClassLike, readHeritage } from "./hostKind";
import type { AnalysisContext, LibraryImports } from "./libraryImports";
import { collectLibraryImports } from "./libraryImports";
import { findSelectorDecorator, visibilityOf } from "./members";

export interface ReadMethodsOptions {
	signatureMode?: SignatureMode;
	/**
	 * Also enumerate methods declared on project-local base classes.
	 *
	 * On by default. A page object that extends a project base class really does
	 * expose that base's helpers, and a caller told otherwise re-implements one
	 * that already exists — which is the failure this whole surface exists to
	 * prevent. Library helpers stay out: they are the same on every page object
	 * and `inheritedApi` on the node already names which base supplies them.
	 *
	 * @default true
	 */
	includeInherited?: boolean;
}

/** The function a class property holds, when it holds one. */
function functionInitializerOf(
	member: ClassMemberTypes,
): ArrowFunction | FunctionExpression | null {
	if (!Node.isPropertyDeclaration(member)) {
		return null;
	}
	// `accessor foo = …` is a field with a getter/setter pair, not a method, and
	// a decorated one is a selector member the tree reports in its own right.
	if (member.hasAccessorKeyword()) {
		return null;
	}
	const initializer = member.getInitializer();
	if (
		initializer &&
		(Node.isArrowFunction(initializer) ||
			Node.isFunctionExpression(initializer))
	) {
		return initializer;
	}
	return null;
}

/**
 * Enumerates the surface a test author can call on a page object.
 *
 * Three things a naive `getMethods()` gets wrong, all of which showed up in the
 * field as an agent writing code that does not run:
 *
 * - **Inherited helpers were invisible.** A project base class's methods are on
 *   the prototype of every subclass; omitting them makes the report a subset of
 *   the truth and the count in `list_page_objects` disagree with the tree.
 * - **Getters were rendered as methods.** `total(): number` for
 *   `get total()` produces `await page.total()` and a `TypeError`.
 * - **Arrow properties were dropped entirely.** `apply = async () => {}` is
 *   callable exactly like a method and is a common style for binding `this`.
 *
 * Shadowing follows the prototype chain: a name declared by the subclass hides
 * the base's member of that name, whatever either one's visibility. The name is
 * recorded **before** the visibility filter, so `private reset()` on a subclass
 * hides — rather than exposes — a public `reset()` on the base. Reporting the
 * base's would be worse than reporting neither: the call does not compile.
 */
export function readMethods(
	classDeclaration: ClassDeclaration,
	imports: LibraryImports,
	ctx: AnalysisContext,
	options: ReadMethodsOptions = {},
): MethodInfo[] {
	const mode = options.signatureMode ?? "syntactic";
	const seen = new Set<string>();
	const out: MethodInfo[] = [];

	const collect = (
		declaration: ClassLike,
		ownImports: LibraryImports,
		inherited: boolean,
	) => {
		const declaredIn = declaration.getName() ?? undefined;
		for (const member of declaration.getMembers()) {
			if (Node.isConstructorDeclaration(member)) {
				continue;
			}
			const name = Node.hasName(member) ? String(member.getName()) : "";
			if (name === "" || seen.has(name)) {
				continue;
			}
			// Before every filter below: an unreported member still shadows.
			seen.add(name);

			if (name.startsWith("#") || visibilityOf(member) === "private") {
				continue;
			}
			// A decorated getter or accessor is a (possibly broken) selector member,
			// not an API method.
			if (findSelectorDecorator(member, ownImports)) {
				continue;
			}

			const info = describe(member, name, mode, ctx);
			if (!info) {
				continue;
			}
			if (inherited) {
				info.inherited = true;
				if (declaredIn) {
					info.declaredIn = declaredIn;
				}
			}
			out.push(info);
		}
	};

	collect(classDeclaration, imports, false);

	if (options.includeInherited !== false) {
		const heritage = readHeritage(classDeclaration, imports, ctx);
		for (const base of heritage.localBases) {
			collect(base, collectLibraryImports(base.getSourceFile(), ctx), true);
		}
	}

	return out;
}

/** One member as a {@link MethodInfo}, or `null` when it is not callable. */
function describe(
	member: ClassMemberTypes,
	name: string,
	mode: SignatureMode,
	ctx: AnalysisContext,
): MethodInfo | null {
	const base = {
		name,
		visibility:
			visibilityOf(member) === "protected"
				? ("protected" as const)
				: ("public" as const),
		loc: ctx.ws.loc(member),
	};

	const finish = (info: MethodInfo): MethodInfo => {
		if (
			(Node.isMethodDeclaration(member) ||
				Node.isPropertyDeclaration(member) ||
				Node.isGetAccessorDeclaration(member) ||
				Node.isSetAccessorDeclaration(member)) &&
			member.isStatic()
		) {
			info.isStatic = true;
		}
		const doc = docSummary(member);
		if (doc) {
			info.doc = doc;
		}
		return info;
	};

	if (Node.isMethodDeclaration(member)) {
		return finish({
			...base,
			kind: "method",
			signature: renderMethod(member, mode),
			isAsync: member.isAsync(),
			returnType: renderReturnType(member, mode),
		});
	}

	if (Node.isGetAccessorDeclaration(member)) {
		return finish({
			...base,
			kind: "getter",
			signature: renderAccessor(member, "getter", mode),
			isAsync: false,
			returnType: renderReturnType(member, mode),
		});
	}

	if (Node.isSetAccessorDeclaration(member)) {
		return finish({
			...base,
			kind: "setter",
			signature: renderAccessor(member, "setter", mode),
			isAsync: false,
			returnType: null,
		});
	}

	const fn = functionInitializerOf(member);
	if (fn && Node.isPropertyDeclaration(member)) {
		const info = finish({
			...base,
			kind: "method",
			signature: renderFunctionProperty(member, fn, mode),
			isAsync: fn.isAsync(),
			returnType: renderFunctionReturnType(fn, mode),
		});
		info.declaredAsProperty = true;
		return info;
	}

	// `count = 0` is a field. It is part of the class, but it is not something a
	// test author calls, and listing it as one would be the same lie in reverse.
	return null;
}
