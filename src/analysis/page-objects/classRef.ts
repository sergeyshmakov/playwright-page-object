import { type ClassDeclaration, Node } from "ts-morph";
import { defKey } from "../util/paths";
import type { RefResolution } from "../util/resolve";
import { type AnalysisContext, LIBRARY_PACKAGE } from "./libraryImports";

/**
 * Turning a resolved identifier into a def key.
 *
 * Its own module because it is the one part of member reading with a life
 * outside it: `fixtures.ts` asks the same question of a `createFixtures` entry
 * that `members.ts` asks of an accessor initializer, and both have to get the
 * same answer about what counts as external.
 */

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
