import {
	Node,
	type ObjectLiteralExpression,
	type PropertyAssignment,
	type ShorthandPropertyAssignment,
	type SourceFile,
	SyntaxKind,
} from "ts-morph";
import { warn } from "../diagnostics";
import type { Diagnostic } from "../types";
import { unwrapTransparent } from "../util/ast";
import { toPosix } from "../util/paths";
import { findImportBinding, resolveModuleSpecifier } from "../util/resolve";
import type { Workspace } from "../workspace";

/**
 * A Playwright config file flattened into an ordered layer stack.
 *
 * What the module exports, the `defineConfig` and `mergeTests` wrappers around
 * it, object spreads, and the one import hop to a base config. Everything here
 * is about *where a value could come from*; reading one out is next door in
 * `configProperty.ts`.
 */

/**
 * How far the reader follows an imported config. One hop covers the shape the
 * ecosystem actually uses — a leaf config importing one shared base — while
 * keeping the read bounded and the failure mode ("could not follow") explicit
 * rather than a silent partial answer.
 */
const MAX_CONFIG_IMPORT_HOPS = 1;
/** Guards a pathological identifier/merge chain from recursing without end. */
export const MAX_LAYER_STEPS = 64;

/** Separator for the (module, export) key below; cannot occur in either half. */
const EXPORT_FIELD = "\u0000";

/**
 * What {@link LayerContext.seen} holds: one *export*, not one file.
 *
 * A module can supply several independent layers - `defineConfig(base,
 * overrides)` importing both from the same file is ordinary - and keying the
 * guard on the path alone made the second one look like a cycle.
 */
export function exportKey(target: SourceFile, exportedName: string): string {
	return `${toPosix(target.getFilePath())}${EXPORT_FIELD}${exportedName}`;
}

/**
 * One object literal contributing to the effective config.
 *
 * A Playwright config is rarely a single literal: `defineConfig({ ...base })`,
 * `defineConfig(merge(base, overrides))` and `import base from "./base"` are all
 * ordinary. Flattening the expression into an ordered list of literals — lowest
 * precedence first — lets one walk answer "who defines `use.testIdAttribute`?"
 * without evaluating anything.
 */
export interface ConfigLayer {
	/**
	 * The own property assignments this layer contributes, in source order.
	 *
	 * One literal can produce several layers, because a spread takes effect
	 * exactly where it is written: `{ use: …, ...base }` is the properties before
	 * the spread, then `base` on top of them. Splitting the literal at each spread
	 * is what keeps the walk's precedence the same as JavaScript's.
	 */
	properties: ConfigProperty[];
	/** The file the literal is written in. */
	sourceFile: SourceFile;
	origin: "primary" | "merge-arg" | "spread" | "imported-base";
	depth: 0 | 1;
	/**
	 * Whether this layer *replaces* the object-valued properties of the layers
	 * below it, rather than merging key by key into them.
	 *
	 * Scalars do not care — the highest layer that writes `testDir` wins either
	 * way — but `use` does. `{ ...base, use: { baseURL } }` is a plain spread, so
	 * the literal's own `use` replaces the base's wholesale and
	 * `base.use.testIdAttribute` never runs. `defineConfig(base, { use: {…} })`
	 * is the opposite: Playwright merges the two with `{...result.use,
	 * ...config.use}`, so the base's key survives unless the argument names it.
	 * Reading both as a deep merge reported an attribute the suite does not use.
	 */
	useShallow: boolean;
	/**
	 * A spread the reader could not follow sits *above* this layer's properties
	 * in the literal that produced it, so anything read here may be overridden by
	 * something the analysis cannot see.
	 */
	occluded?: true;
}

export interface LayerContext {
	workspace: Workspace;
	notes: Diagnostic[];
	/**
	 * `(module, export)` keys on the *active* path, so an import cycle
	 * terminates without a second export of the same module being mistaken for
	 * one. See {@link exportKey}.
	 */
	seen: Set<string>;
	/** A spread the reader could not follow: the attribute may live inside it. */
	unfollowableSpread: boolean;
	steps: number;
}

interface LayerRequest {
	expression: Node;
	sourceFile: SourceFile;
	depth: 0 | 1;
	origin: ConfigLayer["origin"];
	/** Suppresses `config-merge-unresolved`; spreads report through their own note. */
	quiet: boolean;
	/** Seeds {@link ConfigLayer.useShallow} for the first layer this produces. */
	useShallow: boolean;
	/** Seeds {@link ConfigLayer.occluded} for every layer this produces. */
	occluded: boolean;
}

/* -------------------------------------------------------------------------- */
/* Layer flattening                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A key a config literal writes, in either spelling.
 *
 * The shorthand form carries no initializer, so nothing can be read out of it -
 * but it is still a *write*, and that is the half that matters: it overrides
 * whatever a lower layer says. The collector skipped shorthands outright, which
 * made `use: { testIdAttribute }` invisible rather than unreadable.
 */
export type ConfigProperty = PropertyAssignment | ShorthandPropertyAssignment;

export function getProperty(
	object: ObjectLiteralExpression,
	name: string,
): PropertyAssignment | undefined {
	const property = object.getProperty(name);
	return property && Node.isPropertyAssignment(property) ? property : undefined;
}

export function stringLiteralValue(node: Node | undefined): string | undefined {
	if (!node) {
		return undefined;
	}
	if (
		Node.isStringLiteral(node) ||
		Node.isNoSubstitutionTemplateLiteral(node)
	) {
		return node.getLiteralValue();
	}
	return undefined;
}

function isDefineConfigCall(node: Node): boolean {
	if (!Node.isCallExpression(node)) {
		return false;
	}
	const expression = node.getExpression();
	if (Node.isIdentifier(expression)) {
		return expression.getText() === "defineConfig";
	}
	if (Node.isPropertyAccessExpression(expression)) {
		return expression.getName() === "defineConfig";
	}
	return false;
}

/**
 * `module.exports = …` in a CommonJS config.
 *
 * `.js` / `.cjs` are advertised config extensions, and a CommonJS config has no
 * `ExportAssignment` at all — without this the file is found, reported as
 * "shape unrecognized" and its `testIdAttribute` silently lost.
 */
export function commonJsExports(sourceFile: SourceFile): Node[] {
	const out: Node[] = [];
	for (const statement of sourceFile.getStatements()) {
		if (!Node.isExpressionStatement(statement)) {
			continue;
		}
		const expression = statement.getExpression();
		if (
			!Node.isBinaryExpression(expression) ||
			expression.getOperatorToken().getKind() !== SyntaxKind.EqualsToken
		) {
			continue;
		}
		const left = expression.getLeft();
		if (!Node.isPropertyAccessExpression(left)) {
			continue;
		}
		const target = left.getExpression();
		const isModuleExports =
			Node.isIdentifier(target) &&
			target.getText() === "module" &&
			left.getName() === "exports";
		const isExportsDefault =
			Node.isIdentifier(target) &&
			target.getText() === "exports" &&
			left.getName() === "default";
		if (isModuleExports || isExportsDefault) {
			out.push(expression.getRight());
		}
	}
	return out;
}

/** The expression a file exports under `name` (`"default"` included). */
function exportedExpression(
	sourceFile: SourceFile,
	name: string,
): Node | undefined {
	if (name === "default") {
		const assignment = sourceFile
			.getExportAssignments()
			.find((candidate) => !candidate.isExportEquals());
		if (assignment) {
			return assignment.getExpression();
		}
		const [equals] = sourceFile
			.getExportAssignments()
			.filter((candidate) => candidate.isExportEquals());
		if (equals) {
			return equals.getExpression();
		}
		const [commonJs] = commonJsExports(sourceFile);
		return commonJs;
	}
	if (name === "*") {
		return undefined;
	}
	return sourceFile.getVariableDeclaration(name)?.getInitializer();
}

function mergeUnresolved(ctx: LayerContext, node: Node): void {
	ctx.notes.push(
		warn(
			"config-merge-unresolved",
			"Part of the Playwright config could not be resolved statically; values it contributes are not visible to the analysis.",
			ctx.workspace.loc(node),
		),
	);
}

/**
 * Flattens a config expression into ordered layers, lowest precedence first.
 *
 * Spreads keep their written position: `{ ...base, a: 1 }` and
 * `{ a: 1, ...base }` flatten to different stacks, exactly as they evaluate
 * differently. Hoisting every spread in front of the literal's own properties
 * was cheaper but silently reported the losing value for a trailing override,
 * with nothing in the notes to say the answer was a guess.
 */
export function layersFromExpression(
	request: LayerRequest,
	ctx: LayerContext,
): ConfigLayer[] {
	if (ctx.steps <= 0) {
		if (!request.quiet) {
			mergeUnresolved(ctx, request.expression);
		}
		return [];
	}
	ctx.steps -= 1;

	const node: Node = unwrapTransparent(request.expression);

	if (Node.isObjectLiteralExpression(node)) {
		return objectLayers(node, request, ctx);
	}

	if (Node.isCallExpression(node)) {
		const args = node.getArguments();
		if (args.length === 0) {
			if (!request.quiet) {
				mergeUnresolved(ctx, node);
			}
			return [];
		}
		// `defineConfig(config)` is the shape almost every repository writes, and
		// one argument is the config itself: no merge, no layer boundary.
		if (args.length === 1 && isDefineConfigCall(node)) {
			return layersFromExpression({ ...request, expression: args[0] }, ctx);
		}
		// Every other call is read as a merge, arguments left to right as lowest to
		// highest. That is literally what Playwright's own `defineConfig(base,
		// overrides)` does (`{...result, ...config, use: {...result.use,
		// ...config.use}}` in `playwright/lib/common/index.js`), and `merge(base,
		// over)` / `defu(over, base)` cannot be told apart statically anyway.
		// Reading only the first argument dropped every override a repository
		// wrote in the second one.
		const origin: ConfigLayer["origin"] =
			request.origin === "primary" ? "merge-arg" : request.origin;
		return args.flatMap((argument, index) =>
			layersFromExpression(
				{
					...request,
					expression: argument,
					origin,
					// A merged argument overrides `use` one key at a time; only a
					// spread replaces the whole object.
					useShallow: index === 0 ? request.useShallow : false,
				},
				ctx,
			),
		);
	}

	if (Node.isIdentifier(node)) {
		const local = request.sourceFile
			.getVariableDeclaration(node.getText())
			?.getInitializer();
		if (local) {
			return layersFromExpression({ ...request, expression: local }, ctx);
		}
		return importedLayers(node.getText(), request, ctx);
	}

	if (!request.quiet) {
		mergeUnresolved(ctx, node);
	}
	return [];
}

/**
 * One object literal, split into layers at each spread it contains.
 *
 * The properties written before a spread are a lower layer than the spread; the
 * ones after it are a higher one. A literal with no spread is one layer, which
 * is every ordinary config.
 *
 * An empty layer is emitted when nothing else was produced — `{}`, or a literal
 * whose only spread could not be followed — because "no layers at all" is how
 * {@link layersOf} recognises an expression it failed to read, and this one was
 * read fine.
 */
function objectLayers(
	object: ObjectLiteralExpression,
	request: LayerRequest,
	ctx: LayerContext,
): ConfigLayer[] {
	const layers: ConfigLayer[] = [];
	let own: ConfigProperty[] = [];
	let groups = 0;
	// Only the first group a literal produces inherits how the literal itself
	// merges into what is below it. Everything after that is composed *by* a
	// spread, which replaces object-valued keys wholesale.
	const nextShallow = (): boolean => (groups === 0 ? request.useShallow : true);
	const flush = (): void => {
		if (own.length > 0) {
			layers.push(layerOf(own, request, nextShallow()));
			groups += 1;
			own = [];
		}
	};
	for (const property of object.getProperties()) {
		if (
			Node.isPropertyAssignment(property) ||
			Node.isShorthandPropertyAssignment(property)
		) {
			own.push(property);
			continue;
		}
		if (!Node.isSpreadAssignment(property)) {
			continue;
		}
		flush();
		const resolved = layersFromExpression(
			{
				expression: property.getExpression(),
				sourceFile: request.sourceFile,
				depth: request.depth,
				origin: "spread",
				quiet: true,
				useShallow: nextShallow(),
				occluded: request.occluded,
			},
			ctx,
		);
		if (resolved.length === 0) {
			ctx.unfollowableSpread = true;
			// The properties written *before* an unfollowable spread may be
			// overridden by it, and nothing here can say whether they are. They stay
			// in the stack — the value is still the best guess — but they are marked,
			// so a read that lands on one answers "unresolved" instead of answering
			// confidently with a value JavaScript may well discard.
			for (const layer of layers) {
				layer.occluded = true;
			}
			continue;
		}
		layers.push(...resolved);
		groups += 1;
	}
	flush();
	if (layers.length === 0) {
		layers.push(layerOf([], request, request.useShallow));
	}
	return layers;
}

function layerOf(
	properties: ConfigProperty[],
	request: LayerRequest,
	useShallow: boolean,
): ConfigLayer {
	return {
		properties,
		sourceFile: request.sourceFile,
		origin: request.origin,
		depth: request.depth,
		useShallow,
		...(request.occluded ? { occluded: true as const } : {}),
	};
}

function importedLayers(
	localName: string,
	request: LayerRequest,
	ctx: LayerContext,
): ConfigLayer[] {
	if (request.depth >= MAX_CONFIG_IMPORT_HOPS) {
		if (!request.quiet) {
			mergeUnresolved(ctx, request.expression);
		}
		return [];
	}
	const binding = findImportBinding(request.sourceFile, localName);
	if (!binding || binding.exportedName === "*") {
		if (!request.quiet) {
			mergeUnresolved(ctx, request.expression);
		}
		return [];
	}
	const target = resolveModuleSpecifier(
		ctx.workspace.project,
		request.sourceFile,
		binding.specifier,
	);
	if (!target) {
		if (!request.quiet) {
			mergeUnresolved(ctx, request.expression);
		}
		return [];
	}
	// Keyed on the *export*, not just the file. `defineConfig(base, overrides)`
	// importing both from one module resolved `base`, marked the module seen, and
	// then rejected `overrides` as a cycle - discarding a layer that may carry the
	// `testDir` or the `use.testIdAttribute` the whole analysis runs on. They are
	// two different exports and only share an address.
	const key = exportKey(target, binding.exportedName);
	if (ctx.seen.has(key)) {
		// A cycle is not a partial read the caller can fix by looking harder.
		if (!request.quiet) {
			mergeUnresolved(ctx, request.expression);
		}
		return [];
	}
	const expression = exportedExpression(target, binding.exportedName);
	if (!expression) {
		// Marked *after* the export resolves, so a name that is not there does not
		// poison the module for every other export of it.
		if (!request.quiet) {
			mergeUnresolved(ctx, request.expression);
		}
		return [];
	}
	// Scoped to the active path rather than to the whole read: added before the
	// recursion and removed after, so the same export reached twice by different
	// routes - `defineConfig(base, base)`, or `readTestIdAttribute` re-flattening
	// a nested `use` from a module the top-level stack already walked - is read
	// both times instead of the second being called a cycle.
	//
	// Termination never depended on this set. `MAX_CONFIG_IMPORT_HOPS` refuses the
	// second hop against a depth that only increases, and `ctx.steps` decrements
	// on every `layersFromExpression` and is never restored.
	ctx.seen.add(key);
	try {
		return layersFromExpression(
			{
				expression,
				sourceFile: target,
				depth: 1,
				origin: "imported-base",
				quiet: request.quiet,
				useShallow: request.useShallow,
				occluded: request.occluded,
			},
			ctx,
		);
	} finally {
		ctx.seen.delete(key);
	}
}

/** Every layer the file's exported config expression contributes. */
export function layersOf(
	sourceFile: SourceFile,
	ctx: LayerContext,
): ConfigLayer[] {
	const candidates: Node[] = [
		...sourceFile
			.getExportAssignments()
			.map((assignment) => assignment.getExpression()),
		...commonJsExports(sourceFile),
	];
	for (const candidate of candidates) {
		const layers = layersFromExpression(
			{
				expression: candidate,
				sourceFile,
				depth: 0,
				origin: "primary",
				quiet: false,
				useShallow: false,
				occluded: false,
			},
			ctx,
		);
		if (layers.length > 0) {
			return layers;
		}
	}
	return [];
}

/* -------------------------------------------------------------------------- */
/* Scalar reads across the layer stack                                        */
/* -------------------------------------------------------------------------- */
