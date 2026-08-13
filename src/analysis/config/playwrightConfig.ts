import * as path from "node:path";
import { Node, type SourceFile } from "ts-morph";
import { info, makeDiag, warn } from "../diagnostics";
import type {
	Diagnostic,
	DiagnosticSeverity,
	PlaywrightConfigInfo,
	TestIdAttributeOrigin,
} from "../types";
import { admitAddedFile } from "../util/fileBudget";
import { toPosix } from "../util/paths";
import type { Workspace } from "../workspace";
import {
	type ConfigDiscovery,
	discoverPlaywrightConfigs,
} from "./configDiscovery";
import {
	commonJsExports,
	exportKey,
	getProperty,
	type LayerContext,
	layersOf,
	MAX_LAYER_STEPS,
	stringLiteralValue,
} from "./configLayers";
import {
	layerProperty,
	originOf,
	readLayered,
	readTestIdAttribute,
} from "./configProperty";

/**
 * Sibling configs read for a *diagnostic* when the chosen one says nothing
 * about the attribute. Three covers the `playwright.config.ts` +
 * `playwright.base.config.ts` + `playwright.ci.config.ts` trio the warning is
 * for, and is small enough that a repository full of shard configs does not
 * turn one tool call into a dozen parses.
 */
const MAX_CONFIG_PROBES = 3;

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
		seen: new Set([exportKey(sourceFile, "default")]),
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
			seen: new Set([exportKey(sourceFile, "default")]),
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
