/**
 * Static-analysis engine for `playwright-page-object`.
 *
 * This is the only module `src/mcp/**` imports. `ts-morph` is reachable from
 * `src/analysis/**` and nowhere else, which keeps `src/index.ts` — the shipped
 * runtime — at zero runtime dependencies. A guard spec enforces that.
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
	buildCoverageReport,
	type CoverageOptions,
} from "./coverage/mapCoverage";
export { matchSelectorToUi, probesFromPattern } from "./coverage/match";
export { editDistance, nearestIds } from "./coverage/suggest";
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
export { toInlineTree } from "./page-objects/inline";
export { buildPageObjectTree, type TreeOptions } from "./page-objects/tree";
export {
	type AttributeCensus,
	attributeVerdict,
	censusFromText,
} from "./tsx/attributeCensus";
export {
	buildTestIdTree,
	type TestIdTreeOptions,
} from "./tsx/tree";
export type * from "./types";
export { normalizeRelPath } from "./util/paths";
export {
	DEFAULT_TEST_ID_ATTRIBUTE,
	type RevalidateResult,
	Workspace,
	type WorkspaceOptions,
} from "./workspace";
