import {
	type ClassDeclaration,
	type ClassExpression,
	type Decorator,
	Node,
	type ParameterDeclaration,
	type PropertyDeclaration,
} from "ts-morph";
import { error, warn } from "../diagnostics";
import type { Diagnostic, HostKind, HostScope } from "../types";
import { type NameRef, readNameRef, resolveClassRef } from "../util/resolve";
import {
	type AnalysisContext,
	canonicalDecoratorName,
	canonicalLocalName,
	collectLibraryImports,
	LIBRARY_BASE_CLASSES,
	type LibraryImports,
	MEMBER_DECORATORS,
	ROOT_DECORATORS,
} from "./libraryImports";

const MAX_HERITAGE_DEPTH = 5;

export type InheritedApi = "PageObject" | "ListPageObject" | "RootPageObject";

/** `const Ctrl = class extends PageObject {}` is a page object too. */
export type ClassLike = ClassDeclaration | ClassExpression;

export interface HeritageInfo {
	/** Base class names from the immediate base upward. */
	chain: string[];
	inheritedApi: InheritedApi | null;
	/** Project-local base classes, nearest first. */
	localBases: ClassLike[];
	/** `true` when the walk stopped at the depth cap rather than at a root. */
	truncated: boolean;
}

function syntheticChain(api: InheritedApi): string[] {
	switch (api) {
		case "PageObject":
			return ["PageObject"];
		case "ListPageObject":
			return ["ListPageObject", "PageObject"];
		case "RootPageObject":
			return ["RootPageObject", "PageObject"];
	}
}

function heritageName(classDeclaration: ClassLike): NameRef | undefined {
	const extendsClause = classDeclaration.getExtends();
	if (!extendsClause) {
		return undefined;
	}
	return readNameRef(extendsClause.getExpression()) ?? undefined;
}

/**
 * Walks `extends` upward, through project-local intermediate classes, until it
 * reaches a library base or the depth cap. Cheap because it never leaves the
 * syntax layer.
 */
export function readHeritage(
	classDeclaration: ClassLike,
	imports: LibraryImports,
	ctx: AnalysisContext,
): HeritageInfo {
	const chain: string[] = [];
	const localBases: ClassLike[] = [];
	let current: ClassLike = classDeclaration;
	let currentImports = imports;

	for (let depth = 0; depth < MAX_HERITAGE_DEPTH; depth += 1) {
		const baseName = heritageName(current);
		if (!baseName) {
			return { chain, inheritedApi: null, localBases, truncated: false };
		}

		const canonical = canonicalLocalName(baseName.qualified, currentImports);
		if (canonical && LIBRARY_BASE_CLASSES.has(canonical)) {
			const api = canonical as InheritedApi;
			chain.push(...syntheticChain(api));
			return { chain, inheritedApi: api, localBases, truncated: false };
		}

		chain.push(baseName.simple);

		const resolution = resolveClassRef(
			ctx.project,
			current.getSourceFile(),
			baseName.qualified,
			ctx.resolveOptions,
		);
		if (
			!resolution.resolved ||
			!(
				Node.isClassDeclaration(resolution.declaration) ||
				Node.isClassExpression(resolution.declaration)
			)
		) {
			return { chain, inheritedApi: null, localBases, truncated: false };
		}
		current = resolution.declaration;
		localBases.push(current);
		currentImports = collectLibraryImports(current.getSourceFile(), ctx);
	}

	return { chain, inheritedApi: null, localBases, truncated: true };
}

/** Class decorator drawn from the library's `Root*` set, if any. */
export function findRootDecorator(
	classDeclaration: ClassDeclaration,
	imports: LibraryImports,
): { decorator: Decorator; name: string } | undefined {
	for (const decorator of classDeclaration.getDecorators()) {
		const canonical = canonicalDecoratorName(decorator, imports);
		if (canonical && ROOT_DECORATORS.has(canonical)) {
			return { decorator, name: canonical };
		}
	}
	return undefined;
}

/** Members carrying a library `Selector*` / `SelectorBy` decorator. */
export function hasDecoratedMembers(
	classDeclaration: ClassDeclaration,
	imports: LibraryImports,
): boolean {
	for (const member of classDeclaration.getMembers()) {
		if (!Node.isDecoratable(member)) {
			continue;
		}
		for (const decorator of member.getDecorators()) {
			const canonical = canonicalDecoratorName(decorator, imports);
			if (canonical && MEMBER_DECORATORS.has(canonical)) {
				return true;
			}
		}
	}
	return false;
}

function typeMentions(typeText: string | undefined, name: string): boolean {
	if (!typeText) {
		return false;
	}
	return new RegExp(`\\b${name}\\b`).test(typeText);
}

function parameterProperties(
	classDeclaration: ClassDeclaration,
): ParameterDeclaration[] {
	const out: ParameterDeclaration[] = [];
	for (const constructorDeclaration of classDeclaration.getConstructors()) {
		for (const parameter of constructorDeclaration.getParameters()) {
			if (parameter.isParameterProperty()) {
				out.push(parameter);
			}
		}
	}
	return out;
}

/**
 * Data properties only.
 *
 * `getDataPropertyValue` (`selectorBy.ts:8-26`) walks the prototype chain with
 * `Object.getOwnPropertyDescriptor` and returns `"value" in descriptor ? … :
 * undefined`. A `get locator()` therefore does **not** satisfy the fragment
 * protocol — and neither does `accessor locator`, which also installs a
 * get/set pair. Only a parameter property or a plain field qualifies.
 */
export function findDataProperty(
	classDeclaration: ClassDeclaration,
	name: string,
): { node: Node; typeText: string | undefined } | undefined {
	for (const parameter of parameterProperties(classDeclaration)) {
		if (parameter.getName() === name) {
			return { node: parameter, typeText: parameter.getTypeNode()?.getText() };
		}
	}
	for (const property of classDeclaration.getProperties()) {
		if (property.getName() !== name) {
			continue;
		}
		if (property.hasAccessorKeyword() || property.hasDeclareKeyword()) {
			continue;
		}
		return { node: property, typeText: property.getTypeNode()?.getText() };
	}
	return undefined;
}

function findAccessorNamed(
	classDeclaration: ClassDeclaration,
	name: string,
): Node | undefined {
	const getter = classDeclaration.getGetAccessor(name);
	if (getter) {
		return getter;
	}
	const property: PropertyDeclaration | undefined =
		classDeclaration.getProperty(name);
	if (property?.hasAccessorKeyword()) {
		return property;
	}
	return undefined;
}

function constructorTakesLocatorFirst(
	classDeclaration: ClassDeclaration,
): boolean {
	for (const constructorDeclaration of classDeclaration.getConstructors()) {
		const first = constructorDeclaration.getParameters()[0];
		if (first && typeMentions(first.getTypeNode()?.getText(), "Locator")) {
			return true;
		}
	}
	return false;
}

export interface HostClassification {
	hostKind: HostKind;
	scope: HostScope;
	heritage: HeritageInfo;
	rootDecorator: { decorator: Decorator; name: string } | null;
	warnings: Diagnostic[];
}

export interface ClassifyOptions {
	/** Set when the class is reached as a `@Selector(..., Ctrl)` factory argument. */
	referencedAsFactoryArg?: boolean;
}

/**
 * Decides how a class obtains its root locator.
 *
 * The order mirrors `resolveLocator` in `selectorBy.ts:46-66`, which checks
 * `LOCATOR_SYMBOL` first, then a `locator` data property, then a `page` data
 * property. A root decorator or a `PageObject` base both supply
 * `LOCATOR_SYMBOL`, so they outrank the `locator`/`page` fallbacks.
 */
export function classifyHost(
	classDeclaration: ClassDeclaration,
	imports: LibraryImports,
	ctx: AnalysisContext,
	options: ClassifyOptions = {},
): HostClassification {
	const warnings: Diagnostic[] = [];
	const heritage = readHeritage(classDeclaration, imports, ctx);
	const rootDecorator = findRootDecorator(classDeclaration, imports) ?? null;
	const decorated = hasDecoratedMembers(classDeclaration, imports);

	if (rootDecorator) {
		const bare =
			rootDecorator.name === "RootSelector" &&
			(rootDecorator.decorator.getArguments().length === 0 ||
				!rootDecorator.decorator.isDecoratorFactory());
		const scope: HostScope = bare ? "body" : "root-selector";

		if (heritage.inheritedApi === "RootPageObject") {
			return {
				hostKind: "rootPageObject",
				scope,
				heritage,
				rootDecorator,
				warnings,
			};
		}
		if (
			heritage.inheritedApi === "PageObject" ||
			heritage.inheritedApi === "ListPageObject"
		) {
			// rootSelectors.ts:55-59 throws for exactly this shape.
			warnings.push(
				error(
					"root-decorator-on-page-object",
					`@${rootDecorator.name} on "${classDeclaration.getName() ?? "(anonymous)"}" throws at construction: a root decorator requires RootPageObject, not PageObject. Extend PageObject only for nested child controls.`,
					ctx.ws.loc(rootDecorator.decorator),
				),
			);
		}
		return { hostKind: "rootPlain", scope, heritage, rootDecorator, warnings };
	}

	if (heritage.inheritedApi === "RootPageObject") {
		return {
			hostKind: "rootPageObject",
			scope: "unknown",
			heritage,
			rootDecorator,
			warnings,
		};
	}
	if (heritage.inheritedApi !== null) {
		return {
			hostKind: "nestedPageObject",
			scope: "parent-locator",
			heritage,
			rootDecorator,
			warnings,
		};
	}

	const locatorProperty = findDataProperty(classDeclaration, "locator");
	if (locatorProperty && typeMentions(locatorProperty.typeText, "Locator")) {
		return {
			hostKind: "fragment",
			scope: "parent-locator",
			heritage,
			rootDecorator,
			warnings,
		};
	}

	const pageProperty = findDataProperty(classDeclaration, "page");
	if (pageProperty && typeMentions(pageProperty.typeText, "Page")) {
		return {
			hostKind: "pageFallback",
			scope: "body",
			heritage,
			rootDecorator,
			warnings,
		};
	}

	if (
		options.referencedAsFactoryArg &&
		constructorTakesLocatorFirst(classDeclaration)
	) {
		return {
			hostKind: "externalControl",
			scope: "parent-locator",
			heritage,
			rootDecorator,
			warnings,
		};
	}

	if (decorated) {
		const getterOnly = findAccessorNamed(classDeclaration, "locator");
		warnings.push(
			warn(
				"missing-host-context",
				getterOnly
					? `"${classDeclaration.getName() ?? "(anonymous)"}" exposes \`locator\` as an accessor, which \`getDataPropertyValue\` skips (it only reads data properties). Selector decorators will throw; use \`constructor(readonly locator: Locator)\` instead.`
					: `"${classDeclaration.getName() ?? "(anonymous)"}" has selector decorators but no host context: no root decorator, no PageObject base, no \`locator\` field and no \`page\` field.`,
				ctx.ws.loc(getterOnly ?? classDeclaration),
			),
		);
	}

	return {
		hostKind: "unknown",
		scope: "unknown",
		heritage,
		rootDecorator,
		warnings,
	};
}
