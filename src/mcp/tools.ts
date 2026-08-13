/**
 * The five handlers `server.ts` binds, in one place.
 *
 * A barrel on purpose. Keeping it means the split touched no test file, and
 * it is what stops the shared context helpers from importing a module that
 * imports them back - the same reason `present/paths.ts` exists.
 */

export {
	handleMapCoverage,
	handleQueryCoverage,
} from "./handlers/coverage";
export {
	handleGetPageObjectTree,
	handleListPageObjects,
} from "./handlers/pageObjects";
export { handleGetTestIdTree } from "./handlers/testIdTree";
export { environmentHint, type ToolSession } from "./toolContext";
