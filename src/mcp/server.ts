import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { Workspace as AnalysisWorkspace, type Workspace } from "../analysis";
import type { McpServerOptions } from "./options";
import { safeHandler } from "./respond";
import {
	getPageObjectTreeInput,
	getTestIdTreeInput,
	listPageObjectsInput,
	mapCoverageInput,
} from "./schemas";
import {
	handleGetPageObjectTree,
	handleGetTestIdTree,
	handleListPageObjects,
	handleMapCoverage,
} from "./tools";

const READ_ONLY = {
	readOnlyHint: true,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const INSTRUCTIONS = `Static-analysis tools for playwright-page-object test suites. All tools are read-only.

Results reflect the files on disk at the moment of the call - edits are visible to the next call, the server never needs a restart. Restart is only required after changing use.testIdAttribute in the Playwright config or moving page objects outside the scanned directories.

Typical flow: list_page_objects first (never glob for page objects), get_page_object_tree before writing or editing a test, get_testid_tree before writing any selector (never invent a test id), map_coverage when a locator times out or after renaming test ids.`;

const LIST_DESCRIPTION = `Lists every Playwright page-object class in this repository that uses playwright-page-object decorators (@RootSelector, @Selector, @ListSelector, @SelectorBy*), with its file path, host kind (rootPageObject / rootPlain / pageFallback / fragment / nestedPageObject / externalControl), root selector, fixture bindings, and member/method counts. Call this FIRST - before grepping or globbing for page objects - whenever you need to know what page objects already exist, whether one already covers the screen you are about to test, or the exact class name to pass to get_page_object_tree. Returns a compact JSON array. It does not include member details; use get_page_object_tree for those.`;

const TREE_DESCRIPTION = `Returns the full selector tree of one page-object class: every decorated accessor with its decorator kind, selector value (test id, role + options, label, ...), the type it resolves to (raw Locator, PageObject, ListPageObject<T>, or a custom control class), and nested control classes expanded inline up to depth. Also lists the class's own method signatures so you can call an existing helper instead of re-implementing it. Use it before writing or editing a test that touches a page object, and before adding an accessor - to avoid duplicating one that already exists. Address the class by "class" name; if that name is ambiguous the error lists candidate files, so re-call with "file" set to one of them. Anything not statically resolvable is marked dynamic with its source text - never guessed.`;

const TESTID_DESCRIPTION = `Returns the tree of test-id attributes rendered by the app's components (JSX/TSX), in nesting order, including ids built from template literals (reported as patterns like CartItem_* with the source expression) and, when followComponents is true, ids contributed by child components imported from other files. The attribute name comes from the Playwright config (use.testIdAttribute), defaulting to data-testid. Use it before writing any selector so you reference ids that actually exist and nest them correctly, when a locator resolves to zero elements, and when deciding between @Selector and @ListSelector for a repeated row. Address by "file", by "component" name, or pass "testId" to find where a known id is rendered. Ids rendered inside a conditional are flagged conditional; ids inside .map() are flagged repeated. One-hop prop forwarding is resolved; anything deeper is marked unresolved rather than guessed.`;

const COVERAGE_DESCRIPTION = `Cross-references the selectors declared by page-object classes against the test ids actually rendered in the app source and returns: matched (with match confidence), uncoveredTestIds (rendered ids no page object references - gaps you could fill, each with a ready-to-paste decorator suggestion), deadSelectors (selectors whose test id is rendered nowhere - broken or stale locators, with nearest-id typo suggestions), nonTestIdSelectors (role/text/label selectors - reported for awareness, NEVER counted as dead since they cannot be checked statically), and unknown buckets for dynamic values. Use it after refactoring a component or renaming test ids, before adding accessors to an existing page object, and when a test times out on a locator - it tells you whether the id disappeared from the UI. Omit class and file to scan the whole project.`;

function readVersion(): string {
	try {
		const packageJson = JSON.parse(
			readFileSync(join(__dirname, "..", "package.json"), "utf8"),
		) as { version?: string };
		return packageJson.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/**
 * Builds the MCP server. The ts-morph workspace is created lazily on the
 * first tool call so the stdio handshake stays fast.
 */
export function createMcpServer(options: McpServerOptions): McpServer {
	let workspace: Workspace | undefined;
	const getWorkspace = (): Workspace => {
		workspace ??= AnalysisWorkspace.acquire({
			projectRoot: options.projectRoot,
			tsconfig: options.tsconfig,
			include: options.srcDirs,
			maxFiles: options.maxFiles,
			attribute: options.attribute,
		});
		return workspace;
	};

	const server = new McpServer(
		{ name: "playwright-page-object", version: readVersion() },
		{ instructions: INSTRUCTIONS },
	);

	server.registerTool(
		"list_page_objects",
		{
			title: "List page objects",
			description: LIST_DESCRIPTION,
			inputSchema: listPageObjectsInput,
			annotations: READ_ONLY,
		},
		safeHandler((args) => handleListPageObjects(getWorkspace(), args)),
	);

	server.registerTool(
		"get_page_object_tree",
		{
			title: "Get page-object selector tree",
			description: TREE_DESCRIPTION,
			inputSchema: getPageObjectTreeInput,
			annotations: READ_ONLY,
		},
		safeHandler((args) => handleGetPageObjectTree(getWorkspace(), args)),
	);

	server.registerTool(
		"get_testid_tree",
		{
			title: "Get rendered test-id tree",
			description: TESTID_DESCRIPTION,
			inputSchema: getTestIdTreeInput,
			annotations: READ_ONLY,
		},
		safeHandler((args) => handleGetTestIdTree(getWorkspace(), args)),
	);

	server.registerTool(
		"map_coverage",
		{
			title: "Map selector/test-id coverage",
			description: COVERAGE_DESCRIPTION,
			inputSchema: mapCoverageInput,
			annotations: READ_ONLY,
		},
		safeHandler((args) => handleMapCoverage(getWorkspace(), args)),
	);

	return server;
}
