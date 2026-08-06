import * as path from "node:path";
import {
	Node,
	type ObjectLiteralExpression,
	type PropertyAssignment,
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
 * Sibling configs consulted when the chosen one says nothing about the
 * attribute. Three is enough for the `playwright.config.ts` +
 * `playwright.base.config.ts` + `playwright.ci.config.ts` trio that motivates
 * the probe, and small enough that a repository full of shard configs does not
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
	object: ObjectLiteralExpression;
	/** The file the literal is written in; `testDir` resolves against its directory. */
	sourceFile: SourceFile;
	origin: "primary" | "merge-arg" | "spread" | "imported-base";
	depth: 0 | 1;
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
}

/* -------------------------------------------------------------------------- */
/* Layer flattening                                                           */
/* -------------------------------------------------------------------------- */

function getProperty(
	object: ObjectLiteralExpression,
	name: string,
): PropertyAssignment | undefined {
	const property = object.getProperty(name);
	return property && Node.isPropertyAssignment(property) ? property : undefined;
}

function hasSpread(object: ObjectLiteralExpression): boolean {
	return object
		.getProperties()
		.some((property) => Node.isSpreadAssignment(property));
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
 * Simplification worth stating: a spread is always treated as *lower*
 * precedence than the literal's own properties, so `{ a: 1, ...base }` is read
 * as if it were `{ ...base, a: 1 }`. The trailing-spread form is vanishingly
 * rare in real configs, and mis-reading it costs at most one attribute read
 * that a `testid-attribute-inherited` note already flags as inherited.
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
		return [
			...spreadLayers(node, request, ctx),
			{
				object: node,
				sourceFile: request.sourceFile,
				origin: request.origin,
				depth: request.depth,
			},
		];
	}

	if (Node.isCallExpression(node)) {
		const args = node.getArguments();
		if (isDefineConfigCall(node)) {
			const [first] = args;
			if (!first) {
				if (!request.quiet) {
					mergeUnresolved(ctx, node);
				}
				return [];
			}
			return layersFromExpression({ ...request, expression: first }, ctx);
		}
		// An unknown call is assumed to be a merge helper — `merge(base, over)`,
		// `defu(over, base)` cannot be told apart statically, so the arguments are
		// read left to right as lowest to highest. Guessing wrong swaps two layers
		// that usually agree; guessing nothing loses the config entirely.
		if (args.length === 0) {
			if (!request.quiet) {
				mergeUnresolved(ctx, node);
			}
			return [];
		}
		const origin: ConfigLayer["origin"] =
			request.origin === "primary" ? "merge-arg" : request.origin;
		return args.flatMap((argument) =>
			layersFromExpression({ ...request, expression: argument, origin }, ctx),
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

function spreadLayers(
	object: ObjectLiteralExpression,
	request: LayerRequest,
	ctx: LayerContext,
): ConfigLayer[] {
	const layers: ConfigLayer[] = [];
	for (const property of object.getProperties()) {
		if (!Node.isSpreadAssignment(property)) {
			continue;
		}
		const resolved = layersFromExpression(
			{
				expression: property.getExpression(),
				sourceFile: request.sourceFile,
				depth: request.depth,
				origin: "spread",
				quiet: true,
			},
			ctx,
		);
		if (resolved.length === 0) {
			ctx.unfollowableSpread = true;
			continue;
		}
		layers.push(...resolved);
	}
	return layers;
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
	| { state: "unresolved"; layer: ConfigLayer; node: Node }
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
	pick: (layer: ConfigLayer) => PropertyAssignment | undefined,
): ScalarRead {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index];
		const property = pick(layer);
		if (!property) {
			continue;
		}
		const initializer = property.getInitializer();
		const value = stringLiteralValue(initializer);
		if (value !== undefined) {
			return { state: "found", value, layer, node: initializer ?? property };
		}
		return { state: "unresolved", layer, node: initializer ?? property };
	}
	return { state: "absent" };
}

function useObject(layer: ConfigLayer): ObjectLiteralExpression | undefined {
	const initializer = getProperty(layer.object, "use")?.getInitializer();
	return initializer && Node.isObjectLiteralExpression(initializer)
		? initializer
		: undefined;
}

function pickTestIdAttribute(
	layer: ConfigLayer,
): PropertyAssignment | undefined {
	const use = useObject(layer);
	return use ? getProperty(use, "testIdAttribute") : undefined;
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
	try {
		// The config normally lives outside the tsconfig `include`, so it has to be
		// added explicitly rather than looked up in the program.
		return workspace.project.addSourceFileAtPathIfExists(posix);
	} catch {
		return undefined;
	}
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
		return emptyInfo(notes, relatives, "none");
	}

	return readChosenConfig(
		workspace,
		sourceFile,
		found.candidates,
		"discovered",
		notes,
	);
}

function emptyInfo(
	notes: Diagnostic[],
	candidates: string[],
	configSource: PlaywrightConfigInfo["configSource"],
): PlaywrightConfigInfo {
	return {
		configFile: null,
		candidates,
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
			configSource,
			testIdAttribute: undefined,
			testDir: undefined,
			projectOverrides: [],
			notes,
		};
	}

	/* ---- testDir ------------------------------------------------------- */

	// Playwright resolves a relative `testDir` against the directory holding the
	// config that wrote it — which, with a merged base config, is not always the
	// chosen file. Reading it against the *defining* layer's file is what makes
	// `testDir: "./specs"` in `playwright/playwright.base.config.ts` mean
	// `playwright/specs`.
	const testDirRead = readLayered(layers, (layer) =>
		getProperty(layer.object, "testDir"),
	);
	let testDir: string | undefined;
	let testDirUnresolved: true | undefined;
	if (testDirRead.state === "found") {
		testDir = workspace.rel(
			path.resolve(
				path.dirname(testDirRead.layer.sourceFile.getFilePath()),
				testDirRead.value,
			),
		);
	} else if (testDirRead.state === "unresolved") {
		testDirUnresolved = true;
		notes.push(
			warn(
				"testdir-unresolved",
				"`testDir` is not a string literal and cannot be resolved without executing the config; tsconfig discovery falls back to the project root.",
				workspace.loc(testDirRead.node),
			),
		);
	}

	/* ---- use.testIdAttribute -------------------------------------------- */

	const attributeRead = readLayered(layers, pickTestIdAttribute);
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
				"`use.testIdAttribute` is not a string literal and cannot be resolved without executing the config.",
				workspace.loc(attributeRead.node),
			),
		);
	} else if (
		ctx.unfollowableSpread ||
		layers.some((layer) => {
			const use = useObject(layer);
			return use ? hasSpread(use) : false;
		})
	) {
		notes.push(
			info(
				"testid-attribute-maybe-spread",
				"The Playwright config spreads an object the analysis could not follow and sets no explicit `testIdAttribute`; the default `data-testid` may be wrong.",
				{ file: configFile, line: 1 },
			),
		);
	}

	/* ---- sibling probe --------------------------------------------------- */

	if (
		testIdAttribute === undefined &&
		!attributeUnresolved &&
		configSource !== "explicit"
	) {
		const probed = probeSiblings(workspace, sourceFile, candidates, notes);
		if (probed) {
			testIdAttribute = probed.attribute;
			testIdAttributeFrom = "sibling-config";
		}
	}

	/* ---- project overrides ----------------------------------------------- */

	const projectOverrides: PlaywrightConfigInfo["projectOverrides"] = [];
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const initializer = getProperty(
			layers[index].object,
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
 * Reads the attribute out of the remaining ranked configs.
 *
 * A repository that splits its config into `playwright.config.ts` (projects,
 * reporters) and `playwright.base.config.ts` (`use`) without importing one from
 * the other still runs with the base's attribute in whichever config CI points
 * at. Guessing silently would be wrong; ignoring it means answering with
 * `data-testid` while the sources say otherwise. So: read it, use it, and say
 * loudly where it came from. The probe contributes the attribute and nothing
 * else — a sibling's `testDir` or `projects` say nothing about this run.
 */
function probeSiblings(
	workspace: Workspace,
	chosen: SourceFile,
	candidates: string[],
	notes: Diagnostic[],
): { attribute: string; from: string } | null {
	const chosenPath = toPosix(chosen.getFilePath());
	const others = candidates
		.filter((candidate) => toPosix(candidate) !== chosenPath)
		.slice(0, MAX_CONFIG_PROBES);

	let winner: { attribute: string; from: string } | null = null;
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
		const read = readLayered(layersOf(sourceFile, ctx), pickTestIdAttribute);
		if (read.state !== "found") {
			continue;
		}
		const from = workspace.rel(candidate);
		if (!winner) {
			winner = { attribute: read.value, from };
			notes.push(
				warn(
					"testid-attribute-inherited",
					`${workspace.rel(chosenPath)} does not set \`use.testIdAttribute\`; "${read.value}" was read from ${from} instead. Confirm that is the config your tests run with.`,
					workspace.loc(read.node),
					{ attribute: read.value, via: "sibling-config", from },
				),
			);
			continue;
		}
		if (read.value !== winner.attribute) {
			notes.push(
				warn(
					"testid-attribute-conflict",
					`Playwright configs disagree about \`use.testIdAttribute\`: ${winner.from} says "${winner.attribute}", ${from} says "${read.value}". "${winner.attribute}" was used.`,
					workspace.loc(read.node),
					{
						attribute: winner.attribute,
						other: read.value,
						from: winner.from,
						conflictsWith: from,
					},
				),
			);
		}
	}
	return winner;
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
