import { type ClassDeclaration, Node } from "ts-morph";
import type { MethodInfo } from "../types";
import { docSummary } from "../util/jsdoc";
import {
	renderMethod,
	renderReturnType,
	type SignatureMode,
} from "../util/signature";
import { readHeritage } from "./hostKind";
import type { AnalysisContext, LibraryImports } from "./libraryImports";
import { collectLibraryImports } from "./libraryImports";
import { findSelectorDecorator } from "./members";

export interface ReadMethodsOptions {
	signatureMode?: SignatureMode;
	/** Also enumerate methods declared on project-local base classes. */
	includeInherited?: boolean;
}

/**
 * Enumerates the public surface a test author can call on a page object.
 *
 * Inherited library helpers (`waitVisible`, `expect`, `$`, the list filters)
 * are deliberately *not* listed: they are the same on every page object, and
 * `inheritedApi` on the node already tells the agent which base supplies them.
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
		declaration: ClassDeclaration,
		ownImports: LibraryImports,
	) => {
		for (const member of declaration.getMembers()) {
			if (Node.isConstructorDeclaration(member)) {
				continue;
			}
			if (
				!Node.isMethodDeclaration(member) &&
				!Node.isGetAccessorDeclaration(member) &&
				!Node.isSetAccessorDeclaration(member)
			) {
				continue;
			}
			const name = member.getName();
			if (name.startsWith("#") || seen.has(name)) {
				continue;
			}
			const scope = member.getScope();
			if (scope === "private") {
				continue;
			}
			// A decorated getter is a (broken) selector member, not an API method.
			if (findSelectorDecorator(member, ownImports)) {
				continue;
			}
			seen.add(name);

			const info: MethodInfo = {
				name,
				kind: Node.isMethodDeclaration(member)
					? "method"
					: Node.isGetAccessorDeclaration(member)
						? "getter"
						: "setter",
				signature: renderMethod(member, mode),
				isAsync: Node.isMethodDeclaration(member) ? member.isAsync() : false,
				returnType: renderReturnType(member, mode),
				loc: ctx.ws.loc(member),
			};
			if (member.isStatic()) {
				info.isStatic = true;
			}
			const doc = docSummary(member);
			if (doc) {
				info.doc = doc;
			}
			out.push(info);
		}
	};

	collect(classDeclaration, imports);

	if (options.includeInherited) {
		const heritage = readHeritage(classDeclaration, imports, ctx);
		for (const base of heritage.localBases) {
			collect(base, collectLibraryImports(base.getSourceFile(), ctx));
		}
	}

	return out;
}
