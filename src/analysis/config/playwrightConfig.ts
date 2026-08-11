import * as path from "node:path";
import {
	Node,
	type ObjectLiteralExpression,
	type PropertyAssignment,
	type ShorthandPropertyAssignment,
	type SourceFile,
	SyntaxKind,
} from "ts-morph";
import { info, makeDiag, warn } from "../diagnostics";
import type {
	Diagnostic,
	DiagnosticSeverity,
	PlaywrightConfigInfo,
	TestIdAttributeOrigin,
} from "../types";
import { admitAddedFile } from "../util/fileBudget";
import { toPosix } from "../util/paths";
import { findImportBinding, resolveModuleSpecifier } from "../util/resolve";
import type { Workspace } from "../workspace";
import {
	type ConfigDiscovery,
	discoverPlaywrightConfigs,
} from "./configDiscovery";

/** `as` / `satisfies` / parentheses hops peeled off one expression. */
const UNWRAP_LIMIT = 3;
/**
 * How far the reader follows an imported config. One hop covers the shape the
 * ecosystem actually uses — a leaf config importing one shared base — while
 * keeping the read bounded and the failure mode ("could not follow") explicit
 * rather than a silent partial answer.
 */
const MAX_CONFIG_IMPORT_HOPS = 1;
/** Guards a pathological identifier/merge chain from recursing without end. */
const MAX_LAYER_STEPS = 64;
/**
 * Sibling configs read for a *diagnostic* when the chosen one says nothing
 * about the attribute. Three covers the `playwright.config.ts` +
 * `playwright.base.config.ts` + `playwright.ci.config.ts` trio the warning is
 * for, and is small enough that a repository full of shard configs does not
 * turn one tool call into a dozen parses.
 */
const MAX_CONFIG_PROBES = 3;

/**
 * One object literal contributing to the effective config.
 *
 * A Playwright config is rarely a single literal: `defineConfig({ ...base })`,
 * `defineConfig(merge(base, overrides))` and `import base from "./base"` are all
 * ordinary. Flattening the expression into an ordered list of literals — lowest
 * precedence first — lets one walk answer "who defines `use.testIdAttribute`?"
 * without evaluating anything.
 */
interface ConfigLayer {
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

interface LayerContext {
	workspace: Workspace;
	notes: Diagnostic[];
	/** Absolute posix paths already followed, so an import cycle terminates. */
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
type ConfigProperty = PropertyAssignment | ShorthandPropertyAssignment;

function getProperty(
	object: ObjectLiteralExpression,
	name: string,
): PropertyAssignment | undefined {
	const property = object.getProperty(name);
	return property && Node.isPropertyAssignment(property) ? property : undefined;
}

function stringLiteralValue(node: Node | undefined): string | undefined {
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
function commonJsExports(sourceFile: SourceFile): Node[] {
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
function layersFromExpression(
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

	let node: Node = request.expression;
	for (let hop = 0; hop < UNWRAP_LIMIT; hop += 1) {
		if (
			Node.isAsExpression(node) ||
			Node.isSatisfiesExpression(node) ||
			Node.isParenthesizedExpression(node)
		) {
			node = node.getExpression();
			continue;
		}
		break;
	}

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
	const absolute = toPosix(target.getFilePath());
	if (ctx.seen.has(absolute)) {
		// A cycle is not a partial read the caller can fix by looking harder.
		if (!request.quiet) {
			mergeUnresolved(ctx, request.expression);
		}
		return [];
	}
	ctx.seen.add(absolute);
	const expression = exportedExpression(target, binding.exportedName);
	if (!expression) {
		if (!request.quiet) {
			mergeUnresolved(ctx, request.expression);
		}
		return [];
	}
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
}

/** Every layer the file's exported config expression contributes. */
function layersOf(sourceFile: SourceFile, ctx: LayerContext): ConfigLayer[] {
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

type ScalarRead =
	| { state: "found"; value: string; layer: ConfigLayer; node: Node }
	| {
			state: "unresolved";
			layer: ConfigLayer;
			node: Node;
			/** `"occluded"`: a literal value that an unfollowable spread may replace. */
			reason?: "occluded";
	  }
	| { state: "absent" };

/**
 * Highest precedence wins, and a layer that *writes* the property stops the
 * walk even when the written value is not a literal.
 *
 * That last part is the whole point: `use: { testIdAttribute: process.env.X }`
 * in the leaf config is positive evidence that the base config's value is not
 * what runs, so falling through to it would report a value the suite never
 * uses. Unknown is reported as unknown.
 */
function readLayered(
	layers: ConfigLayer[],
	pick: (layer: ConfigLayer) => ConfigProperty | undefined,
): ScalarRead {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index];
		const property = pick(layer);
		if (!property) {
			continue;
		}
		// A shorthand has no initializer to read. `use: { testIdAttribute }` used to
		// be dropped by the collector entirely, so the whole analysis ran against
		// the default attribute with nothing said about it - the one config mistake
		// that silently invalidates every id in the report. It is a write like any
		// other now, and an unreadable one, so it stops the walk and says so.
		const initializer = Node.isPropertyAssignment(property)
			? property.getInitializer()
			: undefined;
		const value = stringLiteralValue(initializer);
		if (value === undefined) {
			return { state: "unresolved", layer, node: initializer ?? property };
		}
		if (layer.occluded) {
			// A literal, read, and still not an answer: an unfollowable spread is
			// written above it, and in JavaScript that spread wins. Reporting the
			// value would be a coin flip presented as a fact.
			return {
				state: "unresolved",
				layer,
				node: initializer ?? property,
				reason: "occluded",
			};
		}
		return { state: "found", value, layer, node: initializer ?? property };
	}
	return { state: "absent" };
}

/**
 * The property this *layer* contributes under `name`, if any.
 *
 * Scoped to the layer's own slice rather than to the whole literal: a property
 * written after a spread belongs to a higher layer than one written before it,
 * and asking the literal would hand both to whichever layer asked first. The
 * last assignment in the slice wins, as it does in JavaScript.
 */
function layerProperty(
	layer: ConfigLayer,
	name: string,
): ConfigProperty | undefined {
	for (let index = layer.properties.length - 1; index >= 0; index -= 1) {
		const property = layer.properties[index];
		if (property.getName() === name) {
			return property;
		}
	}
	return undefined;
}

/**
 * Reads `use.testIdAttribute` across the stack, layering the nested object too.
 *
 * `use` is a config object in its own right: it can spread another one, be an
 * imported constant, or be assembled by a helper. Looking the key up directly on
 * the literal reported `"data-leaf"` for
 * `use: { testIdAttribute: "data-leaf", ...baseUse }`, where JavaScript gives
 * the trailing spread the last word — so the nested object goes through the same
 * {@link objectLayers} splitting the top level does, and the same
 * highest-layer-wins walk reads it.
 *
 * The other half is what an *absent* key means. A `use` reached through a spread
 * replaces the `use` of everything below it, key or no key, so the walk stops
 * there; one reached as a merge argument only overrides the keys it names, so
 * the walk continues. {@link ConfigLayer.useShallow} is which of the two applies.
 */
function readTestIdAttribute(
	layers: ConfigLayer[],
	ctx: LayerContext,
): ScalarRead {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index];
		const property = layerProperty(layer, "use");
		if (!property) {
			continue;
		}
		const initializer = Node.isPropertyAssignment(property)
			? property.getInitializer()
			: undefined;
		const nested = initializer
			? layersFromExpression(
					{
						expression: initializer,
						sourceFile: layer.sourceFile,
						depth: layer.depth,
						origin: layer.origin,
						// The gap inside `use` is reported by the attribute's own notes,
						// not as one more unreadable merge argument.
						quiet: true,
						useShallow: false,
						occluded: layer.occluded === true,
					},
					ctx,
				)
			: [];
		if (nested.length === 0) {
			// `use` is written as something that cannot be opened — a call, an
			// element access. That says the config sets `use`; it does not say what
			// is in it, and the layers below it are no longer the answer either.
			return { state: "unresolved", layer, node: initializer ?? property };
		}
		const read = readLayered(nested, (candidate) =>
			layerProperty(candidate, "testIdAttribute"),
		);
		if (read.state !== "absent") {
			return read;
		}
		// This layer writes `use` without the key. Skip everything its own object
		// replaces; resume at the first layer it merely merges into.
		let below = index;
		while (below > 0 && layers[below].useShallow) {
			below -= 1;
		}
		index = below;
	}
	return { state: "absent" };
}

function originOf(layer: ConfigLayer): TestIdAttributeOrigin {
	switch (layer.origin) {
		case "primary":
			return "primary";
		case "merge-arg":
			return "merge-layer";
		case "imported-base":
			return "base-config";
		default:
			return "spread";
	}
}

/* -------------------------------------------------------------------------- */
/* Public reader                                                              */
/* -------------------------------------------------------------------------- */

function addConfigFile(
	workspace: Workspace,
	absolute: string,
): SourceFile | undefined {
	const posix = toPosix(absolute);
	const existing = workspace.project.getSourceFile(posix);
	if (existing) {
		return existing;
	}
	let added: SourceFile | undefined;
	try {
		// The config normally lives outside the tsconfig `include`, so it has to be
		// added explicitly rather than looked up in the program.
		added = workspace.project.addSourceFileAtPathIfExists(posix);
	} catch {
		return undefined;
	}
	if (added) {
		// Outside the `try`, and through the same gate as every other on-demand
		// load: a config is a parsed file like any other. Reading one can pull in
		// an imported base and up to three siblings, and letting those in without
		// asking left a project already at `--max-files` holding more than the cap
		// allows, with nothing said about it.
		admitAddedFile(workspace.project, added);
	}
	return added;
}

/**
 * Reads `playwright.config.*` **statically** — the config is never executed, so
 * `testIdAttribute: process.env.X` resolves to `undefined` plus a diagnostic
 * rather than to whatever the analysing process happens to have in its env.
 *
 * `discovery` is the workspace's cached candidate list. Omitting it makes the
 * reader run its own search, which is what direct callers and unit tests want.
 */
export function readPlaywrightConfig(
	workspace: Workspace,
	explicitPath?: string,
	discovery?: ConfigDiscovery,
): PlaywrightConfigInfo {
	const notes: Diagnostic[] = [];

	if (explicitPath) {
		const absolute = path.isAbsolute(explicitPath)
			? explicitPath
			: path.resolve(workspace.root, explicitPath);
		const sourceFile = addConfigFile(workspace, absolute);
		if (!sourceFile) {
			// No discovery fallback: a caller who named a config and got a different
			// one read instead would be told an attribute that has nothing to do
			// with the file they pointed at.
			notes.push(
				warn(
					"playwright-config-not-found",
					`The Playwright config "${toPosix(explicitPath)}" does not exist; no config was read and Playwright's defaults are assumed.`,
					undefined,
					{ explicit: toPosix(explicitPath) },
				),
			);
			return emptyInfo(notes, [], "none");
		}
		// No candidates: naming a config suppresses discovery, so there is no
		// ranked list to report and `candidates` stays empty by contract.
		return readChosenConfig(workspace, sourceFile, [], "explicit", notes);
	}

	const found =
		discovery ?? discoverPlaywrightConfigs(workspace.project, workspace.root);
	const relatives = found.candidates.map((candidate) =>
		workspace.rel(candidate),
	);

	const [chosen] = found.candidates;
	if (!chosen) {
		notes.push(
			info(
				"playwright-config-not-found",
				`No playwright*.config.{ts,mts,cts,js,mjs,cjs} was found under ${toPosix(workspace.root)}; assuming Playwright defaults, including the data-testid attribute.`,
			),
		);
		return emptyInfo(notes, [], "none");
	}

	const sourceFile = addConfigFile(workspace, chosen);
	if (!sourceFile) {
		notes.push(
			info(
				"playwright-config-not-found",
				`The discovered Playwright config ${workspace.rel(chosen)} could not be read; assuming Playwright defaults.`,
			),
		);
		return emptyInfo(notes, relatives, "none", found.truncated);
	}

	return readChosenConfig(
		workspace,
		sourceFile,
		found.candidates,
		"discovered",
		notes,
		found.truncated,
	);
}

function emptyInfo(
	notes: Diagnostic[],
	candidates: string[],
	configSource: PlaywrightConfigInfo["configSource"],
	candidatesTruncated?: true,
): PlaywrightConfigInfo {
	return {
		configFile: null,
		candidates,
		...(candidatesTruncated ? { candidatesTruncated } : {}),
		configSource,
		testIdAttribute: undefined,
		testDir: undefined,
		projectOverrides: [],
		notes,
	};
}

function readChosenConfig(
	workspace: Workspace,
	sourceFile: SourceFile,
	candidates: string[],
	configSource: "discovered" | "explicit",
	notes: Diagnostic[],
	candidatesTruncated?: true,
): PlaywrightConfigInfo {
	const configFile = workspace.rel(sourceFile.getFilePath());
	const relatives = candidates.map((candidate) => workspace.rel(candidate));

	const ctx: LayerContext = {
		workspace,
		notes,
		seen: new Set([toPosix(sourceFile.getFilePath())]),
		unfollowableSpread: false,
		steps: MAX_LAYER_STEPS,
	};
	const layers = layersOf(sourceFile, ctx);

	if (layers.length === 0) {
		const [reasonNode] = [
			...sourceFile
				.getExportAssignments()
				.map((assignment) => assignment.getExpression()),
			...commonJsExports(sourceFile),
		];
		notes.push(
			warn(
				"config-shape-unrecognized",
				"Could not statically resolve the default export of the Playwright config to an object literal.",
				reasonNode ? workspace.loc(reasonNode) : { file: configFile, line: 1 },
			),
		);
		reportAmbiguity(notes, relatives, configFile, false);
		return {
			configFile,
			candidates: relatives,
			...(candidatesTruncated ? { candidatesTruncated } : {}),
			configSource,
			testIdAttribute: undefined,
			testDir: undefined,
			projectOverrides: [],
			notes,
		};
	}

	/* ---- testDir ------------------------------------------------------- */

	// Playwright resolves every relative path in the effective config against the
	// directory of the config file it *loaded*, never the module a value was
	// written in: `configDir` is `path.dirname(resolvedConfigFile)`, and a base
	// config reached by import or spread contributes a plain string with no
	// provenance attached. So `testDir: "./specs"` in
	// `playwright/base.ts`, spread into a root `playwright.config.ts`, means
	// `<root>/specs` — resolving it against the base's own directory pointed the
	// workspace at a directory Playwright never reads, and picked up whatever
	// tsconfig sits next to it.
	const testDirRead = readLayered(layers, (layer) =>
		layerProperty(layer, "testDir"),
	);
	let testDir: string | undefined;
	let testDirUnresolved: true | undefined;
	if (testDirRead.state === "found") {
		testDir = workspace.rel(
			path.resolve(path.dirname(sourceFile.getFilePath()), testDirRead.value),
		);
	} else if (testDirRead.state === "unresolved") {
		testDirUnresolved = true;
		notes.push(
			warn(
				"testdir-unresolved",
				testDirRead.reason === "occluded"
					? "`testDir` is written above a spread the analysis could not follow, which would override it; tsconfig discovery falls back to the project root."
					: "`testDir` is not a string literal and cannot be resolved without executing the config; tsconfig discovery falls back to the project root.",
				workspace.loc(testDirRead.node),
			),
		);
	}

	/* ---- use.testIdAttribute -------------------------------------------- */

	const attributeRead = readTestIdAttribute(layers, ctx);
	let testIdAttribute: string | undefined;
	let testIdAttributeFrom: TestIdAttributeOrigin | undefined;
	let attributeUnresolved = false;

	if (attributeRead.state === "found") {
		testIdAttribute = attributeRead.value;
		testIdAttributeFrom = originOf(attributeRead.layer);
		if (testIdAttributeFrom !== "primary") {
			const where = workspace.rel(attributeRead.layer.sourceFile.getFilePath());
			notes.push(
				info(
					"testid-attribute-inherited",
					where === configFile
						? `\`use.testIdAttribute\` is "${testIdAttribute}", contributed by a merged layer of ${configFile} rather than by its own object literal.`
						: `\`use.testIdAttribute\` is "${testIdAttribute}", written in ${where} and merged into ${configFile}.`,
					workspace.loc(attributeRead.node),
					{ attribute: testIdAttribute, via: testIdAttributeFrom, from: where },
				),
			);
		}
	} else if (attributeRead.state === "unresolved") {
		attributeUnresolved = true;
		notes.push(
			warn(
				"testid-attribute-unresolved",
				attributeRead.reason === "occluded"
					? "`use.testIdAttribute` is written above a spread the analysis could not follow; JavaScript would let that spread override it, so the value it names is not reported. Set the attribute explicitly with --attribute if it is the one your tests run with."
					: "`use.testIdAttribute` is not a string literal and cannot be resolved without executing the config.",
				workspace.loc(attributeRead.node),
			),
		);
	} else if (ctx.unfollowableSpread) {
		notes.push(
			info(
				"testid-attribute-maybe-spread",
				"The Playwright config spreads an object the analysis could not follow and sets no explicit `testIdAttribute`; the default `data-testid` may be wrong.",
				{ file: configFile, line: 1 },
			),
		);
	}

	/* ---- sibling configs: reported, never applied ------------------------ */

	if (
		testIdAttribute === undefined &&
		!attributeUnresolved &&
		configSource !== "explicit"
	) {
		probeSiblings(workspace, sourceFile, candidates, notes);
	}

	/* ---- project overrides ----------------------------------------------- */

	const projectOverrides: PlaywrightConfigInfo["projectOverrides"] = [];
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const initializer = layerProperty(
			layers[index],
			"projects",
		)?.getInitializer();
		if (!initializer || !Node.isArrayLiteralExpression(initializer)) {
			continue;
		}
		for (const element of initializer.getElements()) {
			if (!Node.isObjectLiteralExpression(element)) {
				continue;
			}
			const projectUse = getProperty(element, "use")?.getInitializer();
			if (!projectUse || !Node.isObjectLiteralExpression(projectUse)) {
				continue;
			}
			const attributeProperty = getProperty(projectUse, "testIdAttribute");
			const value = stringLiteralValue(attributeProperty?.getInitializer());
			if (value === undefined || !attributeProperty) {
				continue;
			}
			projectOverrides.push({
				project:
					stringLiteralValue(getProperty(element, "name")?.getInitializer()) ??
					null,
				testIdAttribute: value,
				loc: workspace.loc(attributeProperty),
			});
		}
		break;
	}

	const disagreeing = projectOverrides.filter(
		(override) => override.testIdAttribute !== testIdAttribute,
	);
	if (disagreeing.length > 0) {
		notes.push(
			info(
				"testid-attribute-project-override",
				`${disagreeing.length} Playwright project(s) override testIdAttribute; analysis uses the top-level value.`,
				disagreeing[0].loc,
			),
		);
	}

	reportAmbiguity(notes, relatives, configFile, testIdAttribute !== undefined);

	return {
		configFile,
		candidates: relatives,
		...(candidatesTruncated ? { candidatesTruncated } : {}),
		configSource,
		testIdAttribute,
		...(testIdAttributeFrom ? { testIdAttributeFrom } : {}),
		testDir,
		...(testDirUnresolved ? { testDirUnresolved } : {}),
		projectOverrides,
		notes,
	};
}

/**
 * Says what the *other* discovered configs set, and applies none of it.
 *
 * Two repository shapes are statically indistinguishable here. One splits its
 * config into `playwright.config.ts` (projects, reporters) and
 * `playwright.base.config.ts` (`use`) with no import between them, and really
 * does run with the base's attribute. The other keeps a `playwright-ct.config.ts`
 * for component tests beside an E2E config that has no relationship to it at
 * all, and running the E2E scan with `data-ct-id` would be wrong about every
 * file. Borrowing the value was a coin flip made silently, while the metadata
 * kept naming the chosen config.
 *
 * So the sibling is read and reported, never applied. Configs the chosen one
 * *is* related to — imported, spread, merged — are layers, and those do apply;
 * a caller who wants the sibling's value names it with an explicit config, or
 * overrides the attribute outright. The attribute census independently flags the
 * case where the assumed attribute appears nowhere in the sources.
 */
function probeSiblings(
	workspace: Workspace,
	chosen: SourceFile,
	candidates: string[],
	notes: Diagnostic[],
): void {
	const chosenPath = toPosix(chosen.getFilePath());
	const chosenRel = workspace.rel(chosenPath);
	const others = candidates
		.filter((candidate) => toPosix(candidate) !== chosenPath)
		.slice(0, MAX_CONFIG_PROBES);

	let first: { attribute: string; from: string } | null = null;
	for (const candidate of others) {
		const sourceFile = addConfigFile(workspace, candidate);
		if (!sourceFile) {
			continue;
		}
		const ctx: LayerContext = {
			workspace,
			notes: [],
			seen: new Set([toPosix(sourceFile.getFilePath())]),
			unfollowableSpread: false,
			steps: MAX_LAYER_STEPS,
		};
		const read = readTestIdAttribute(layersOf(sourceFile, ctx), ctx);
		if (read.state !== "found") {
			continue;
		}
		const from = workspace.rel(candidate);
		if (!first) {
			first = { attribute: read.value, from };
			notes.push(
				warn(
					"testid-attribute-sibling",
					`${from} sets \`use.testIdAttribute\` to "${read.value}", but ${chosenRel} — the config that was read — neither sets it nor imports that file, so the value was not applied. Point the analysis at ${from}, or set the attribute explicitly, if that is what your tests run with.`,
					workspace.loc(read.node),
					{ attribute: read.value, from, applied: false },
				),
			);
			continue;
		}
		if (read.value !== first.attribute) {
			notes.push(
				warn(
					"testid-attribute-conflict",
					`Playwright configs disagree about \`use.testIdAttribute\`: ${first.from} says "${first.attribute}", ${from} says "${read.value}". Neither was applied; ${chosenRel} was read.`,
					workspace.loc(read.node),
					{
						attribute: first.attribute,
						other: read.value,
						from: first.from,
						conflictsWith: from,
					},
				),
			);
		}
	}
}

/**
 * Says which config was read whenever more than one exists.
 *
 * Severity varies with the stakes: once an attribute is resolved the note is a
 * disclosure, but a repository with several configs and no attribute anywhere is
 * exactly the case where the analysis quietly defaulted to `data-testid` and the
 * caller has a file to point at.
 */
function reportAmbiguity(
	notes: Diagnostic[],
	relatives: string[],
	configFile: string,
	attributeResolved: boolean,
): void {
	if (relatives.length <= 1) {
		return;
	}
	const others = relatives.filter((candidate) => candidate !== configFile);
	const severity: DiagnosticSeverity = attributeResolved ? "info" : "warning";
	notes.push(
		makeDiag(
			"playwright-config-ambiguous",
			severity,
			`${relatives.length} Playwright configs were found; ${configFile} was read. Others: ${others.slice(0, 5).join(", ")}${others.length > 5 ? ", …" : ""}.`,
			{ file: configFile, line: 1 },
			{ chosen: configFile, count: relatives.length, others: others.join(",") },
		),
	);
}
