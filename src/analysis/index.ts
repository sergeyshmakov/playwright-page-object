/**
 * Static-analysis engine for `playwright-page-object`.
 *
 * The module `src/mcp/**` imports the engine through. `ts-morph` is reachable
 * from `src/analysis/**` and nowhere else, which keeps `src/index.ts` — the
 * shipped runtime — at zero runtime dependencies.
 *
 * What the guard spec enforces is that *reachability*, not this barrel's
 * exclusivity: `src/mcp/options.ts` deliberately deep-imports `util/paths`
 * instead, because it runs on the startup path and must not pull the analyser
 * in to stat four paths — and it has a guard of its own proving ts-morph stays
 * out of its import graph. Anything that already loads the engine comes through
 * here.
 *
 * Every entry point is `(Workspace, options) => JSON`. Problems in user code
 * become `warnings: Diagnostic[]`; only a missing target throws, as
 * {@link AnalysisTargetError}.
 */
export {
	CONFIG_GLOB,
	type ConfigDiscovery,
	discoverPlaywrightConfigs,
	MAX_CONFIG_CANDIDATES,
	rankConfigCandidates,
} from "./config/configDiscovery";
export { readPlaywrightConfig } from "./config/playwrightConfig";
export {
	locateTsConfig,
	type TsConfigLocation,
} from "./config/tsconfig";
export {
	findPageObjectTsConfigCandidates,
	type PageObjectTsConfigCandidate,
	type PageObjectTsConfigCandidates,
} from "./config/tsconfigAlternatives";
export {
	classifySelector,
	type SelectorClassification,
} from "./coverage/classify";
export {
	buildCoverageReport,
	type CoverageOptions,
	partitionInventory,
} from "./coverage/mapCoverage";
export {
	isCatchAllPattern,
	matchSelectorToUi,
	probesFromPattern,
} from "./coverage/match";
export {
	editDistance,
	nearestFiles,
	nearestIds,
	nearestNames,
} from "./coverage/suggest";
export {
	AnalysisLimitError,
	AnalysisTargetError,
	dedupeDiagnostics,
	makeDiag,
} from "./diagnostics";
export {
	type DiscoverOptions,
	discoverPageObjects,
} from "./page-objects/discover";
export {
	buildPageObjectTree,
	isDynamicMember,
	type TreeOptions,
} from "./page-objects/tree";
export {
	type AttributeCensus,
	attributeVerdict,
	censusFromText,
} from "./tsx/attributeCensus";
export { staticId } from "./tsx/scanTestIds";
export {
	buildTestIdTree,
	type EntryPathMatch,
	entryFileCandidates,
	matchEntryPath,
	scannedComponents,
	type TestIdTreeOptions,
} from "./tsx/tree";
export type * from "./types";
export { foldPath, normalizeRelPath } from "./util/paths";
export {
	DEFAULT_TEST_ID_ATTRIBUTE,
	type RevalidateResult,
	Workspace,
	type WorkspaceOptions,
	WorkspacePool,
} from "./workspace";
