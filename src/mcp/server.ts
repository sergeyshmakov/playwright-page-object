import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { type Workspace, WorkspacePool } from "../analysis";
import {
	CoverageHandles,
	HANDLE_LIFETIME_CLAUSE,
	HANDLE_LIFETIME_TEXT,
} from "./handles";
import type { McpServerOptions } from "./options";
import {
	envelopeValidationErrors,
	MAX_RESPONSE_BYTES,
	safeHandler,
} from "./respond";
import {
	getPageObjectTreeInput,
	getTestIdTreeInput,
	listPageObjectsInput,
	mapCoverageInput,
	queryCoverageInput,
} from "./schemas";
import {
	handleGetPageObjectTree,
	handleGetTestIdTree,
	handleListPageObjects,
	handleMapCoverage,
	handleQueryCoverage,
} from "./tools";
import { WarningLedger } from "./warnings";

const READ_ONLY = {
	readOnlyHint: true,
	idempotentHint: true,
	openWorldHint: false,
} as const;

/**
 * Per-tool result-size ceiling, read by Claude Code from `tools/list`.
 *
 * Without it a client applies its own default (25k tokens there) and, past
 * that, persists the result to disk and hands the model a file reference. The
 * annotation raises the ceiling for these tools specifically, up to the
 * client's own 500k hard limit. It is an unknown key to every other client and
 * is ignored, so it costs nothing to send.
 *
 * Only the tools that legitimately answer big get it: the two coverage tools
 * and a deep selector graph. The list and test-id tree tools page or narrow,
 * and a large answer from them means the caller should do that instead.
 *
 * Derived from the cap the server actually enforces, not written out. It said
 * 400,000 while `MAX_RESPONSE_BYTES` was 200,000, so the annotation invited
 * clients to accept twice what this server will ever send — and a client that
 * raised its own ceiling on the strength of it got a `too_large` instead of the
 * big answer it had just made room for. The unit differs (the annotation counts
 * characters, the cap counts UTF-8 bytes) and that only ever errs safe: a
 * character is never more than one byte's worth of allowance.
 */
const LARGE_RESULT = {
	"anthropic/maxResultSizeChars": MAX_RESPONSE_BYTES,
} as const;

/**
 * The `format` default, read off the schema rather than written out.
 *
 * This sentence said "use the default JSON" for four commits after the default
 * became `outline` — the flip updated the schemas, the two tool descriptions and
 * the docs, and missed the one piece of text every session reads. Interpolating
 * it makes that drift impossible, the way {@link HANDLE_LIFETIME_TEXT} is
 * derived from the TTL and the response cap from its constant.
 */
const FORMAT_DEFAULT = getTestIdTreeInput.parse({}).format;
const FORMAT_ALTERNATIVE = FORMAT_DEFAULT === "outline" ? "json" : "outline";

const INSTRUCTIONS = `Static-analysis tools for playwright-page-object test suites. All tools are read-only.

Results reflect the files on disk at the moment of the call - edits (including Playwright config changes) are visible to the next call. A restart is only needed to change the server's own flags, such as --src-dir scope or --attribute.

Typical flow: list_page_objects first (never glob for page objects), get_page_object_tree before writing or editing a test, get_testid_tree before writing any selector (never invent a test id), map_coverage when a locator times out or after renaming test ids.

Both tree tools default to format:"${FORMAT_DEFAULT}". Outline is an indented text tree that costs a fraction of the tokens and summarises repeats and holes; json carries every node and every field. Pass format:"${FORMAT_ALTERNATIVE}" when you want the other one - json when something has to parse fields.

Writing the test body from a tree: a page object's members are plain properties, so the tree is the call chain - \`checkoutPage.CartItems.first().RemoveButton\`. A member whose result is Locator is a Playwright Locator and takes Playwright calls directly; a pageObject or list member is a library page object, whose raw locator is \`.$\`. A control is a project class and has \`.$\` only if it extends PageObject, which its own node in defs shows. A member reported unknown or dynamic resolved to nothing statically - read the source text the payload carries for it instead of calling anything on it. A root class is constructed as \`new CheckoutPage(page)\`, or taken as a test argument when the node lists a fixture binding. The methods in the tree are the class's own; the inherited library helpers - the waits on PageObject, the item and filter methods on ListPageObject - are named by inheritedApi and spelled out in meta.apiHints of the same response, so do not go and read the package sources for them.

Reading a coverage report: call map_coverage summary-first with buckets: [] to get the totals and the scope for a small fraction of the full report, then page the one list that matters with query_coverage, passing meta.coverageId and one bucket. query_coverage returns meta.nextOffset as a single number - copy it into the next call's offset and stop when that key stops coming back. (map_coverage can return several buckets at once, so its meta.nextOffset is an object keyed by bucket; read the one you want rather than passing the object.) summary reports every bucket's real size throughout, so a capped page always says how much it is hiding. ${HANDLE_LIFETIME_CLAUSE}

meta.warnings sends each distinct warning in full once per session. After that the same warning comes back as {code, severity, repeat: N} with no message, meaning N warnings of that code are still in force and their text has not changed since it was sent; a warning whose details change is sent in full again. meta.hint is never abbreviated - it always carries the current advice in full, so act on it and treat a bare code as a reminder rather than something to re-read.

A coverage page is never refused for being long: map_coverage and query_coverage trim instead, so summary and scope always ship, meta.truncatedBuckets names the lists that were cut, and meta.nextOffset says where to resume. An empty bucket in such a response means "cut here", not "nothing found" - read summary. The other three tools do refuse an oversized response, with error code too_large and a hint naming the arguments that call actually has.`;

const LIST_DESCRIPTION = `Lists every Playwright page-object class in this repository that uses playwright-page-object decorators (@RootSelector, @Selector, @ListSelector, @SelectorBy*), with its file path, host kind (rootPageObject / rootPlain / pageFallback / fragment / nestedPageObject / externalControl), root selector, fixture bindings, and member/method counts. Call this FIRST - before grepping or globbing for page objects - whenever you need to know what page objects already exist, whether one already covers the screen you are about to test, or the exact class name to pass to get_page_object_tree. Returns a compact JSON array. It does not include member details; use get_page_object_tree for those. meta.total always reports the unpaged count; page a large index with limit + offset, following meta.nextOffset.`;

const TREE_DESCRIPTION = `Returns the full selector tree of one page-object class: every decorated accessor with its decorator kind, selector value (test id, role + options, label, ...), the type it resolves to (raw Locator, PageObject, ListPageObject<T>, or a custom control class), and nested control classes expanded inline up to depth. Use it before writing or editing a test that touches a page object, and before adding an accessor - to avoid duplicating one that already exists. Address the class by "class" name; if that name is ambiguous the error lists candidate files, so re-call with "file" set to one of them. Anything not statically resolvable is marked dynamic with its source text - never guessed. The listed methods are the ones the class itself declares (plus any on a project-local base), so you can call an existing helper instead of re-implementing it; the helpers it inherits from the library are not repeated per class - "inheritedApi" names the base that supplies them and meta.apiHints gives their call syntax, which together with the tree is everything the test body needs. Returns format:"${FORMAT_DEFAULT}" unless you ask otherwise: outline is indented text costing a fraction of the tokens, json carries every node and field for a program to parse.`;

const TESTID_DESCRIPTION = `Returns the tree of test-id attributes rendered by the app's components (JSX/TSX), in nesting order, including ids built from template literals (reported as patterns like CartItem_* with the source expression) and, when followComponents is true, ids contributed by child components imported from other files. The attribute name comes from the Playwright config (use.testIdAttribute), defaulting to data-testid. Use it before writing any selector so you reference ids that actually exist and nest them correctly, when a locator resolves to zero elements, and when deciding between @Selector and @ListSelector for a repeated row. Address by "file", by "component" name, or by both when two files declare the same component name; or pass "testId" to find where a known id is rendered. Ids rendered inside a conditional are flagged conditional; ids inside .map() are flagged repeated. One-hop prop forwarding is resolved; anything deeper is marked unresolved rather than guessed. Returns format:"${FORMAT_DEFAULT}" unless you ask otherwise: outline is indented text costing a fraction of the tokens, json carries every node and field for a program to parse.`;

const COVERAGE_DESCRIPTION = `Cross-references the selectors declared by page-object classes against the test ids actually rendered in the app source and returns: matched (with match confidence), uncoveredTestIds (rendered ids no page object references - gaps you could fill, each with a ready-to-paste decorator suggestion), deadSelectors (selectors whose test id is rendered nowhere - broken or stale locators, with nearest-id typo suggestions), nonTestIdSelectors (role/text/label selectors - reported for awareness, NEVER counted as dead since they cannot be checked statically), and unknown buckets for dynamic values and for ids passed to components that never provably forward them to the DOM. Use it after refactoring a component or renaming test ids, before adding accessors to an existing page object, and when a test times out on a locator - it tells you whether the id disappeared from the UI. Omit class and file to scan the whole project. summary.coverage is null rather than 1 when nothing was matchable, and scope reports what the two sides were drawn from - read the warnings before acting on a number. Request only the lists you need with buckets; buckets: [] returns summary and scope alone, which is the cheapest way to see the shape of the answer before asking for a list. Every response carries meta.coverageId, an opaque handle to this exact report that query_coverage pages one bucket at a time without restating class / file / attribute. ${HANDLE_LIFETIME_TEXT} A page too large for the response cap is trimmed rather than refused: meta.truncatedBuckets names what was cut and meta.nextOffset says where to resume.`;

const QUERY_DESCRIPTION = `Pages one bucket of a coverage report that map_coverage already built, addressed by the opaque meta.coverageId that call returned. Takes coverageId, one bucket name, offset and limit, and returns that bucket's page alongside the same summary map_coverage ships, so a capped page still reports every bucket's real size. scope ships on the first page only (offset 0): the handle pins one snapshot, so it is identical on every later page and map_coverage already gave it to you. Use it to walk a long list to its end - copy meta.nextOffset into the next call's offset and stop when that key stops coming back - and to avoid restating the class / file / attribute / includeRawLocators scope of the original call, which the handle carries. It also holds the report still: the same id answers from the same snapshot every time, and if the sources change underneath it the call fails with expired_handle instead of quietly renumbering the list your offsets point into. ${HANDLE_LIFETIME_CLAUSE}`;

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
	const workspaceOptions = {
		projectRoot: options.projectRoot,
		tsconfig: options.tsconfig,
		playwrightConfig: options.playwrightConfig,
		include: options.srcDirs,
		maxFiles: options.maxFiles,
		attribute: options.attribute,
	};
	// One pool per server, like the handle store below: a second server in the
	// same process analyses its own root and must not be handed a workspace
	// built for another one.
	const workspaces = new WorkspacePool();
	// Re-acquired on every call, never memoized here: `acquire` builds the
	// workspace on first use and afterwards returns the cached one (LRU of 2)
	// only after an mtime revalidation sweep. That sweep is what makes a
	// long-lived stdio session see edits made since the previous call.
	const getWorkspace = (): Workspace => workspaces.acquire(workspaceOptions);

	const server = new McpServer(
		{ name: "playwright-page-object", version: readVersion() },
		{ instructions: INSTRUCTIONS },
	);
	// Schema-validation failures are the SDK's, raised before any handler
	// runs. Without this they leave as a bare string while every other
	// failure leaves as `{ok:false,error:{…}}`.
	envelopeValidationErrors(server);

	// One store per server, so a handle cannot outlive the process that issued it
	// or reach a workspace it was not built against.
	const handles = new CoverageHandles();
	// Likewise per server: "already sent" is a fact about one conversation, and a
	// ledger shared between two of them would abbreviate for a reader who never
	// saw the original.
	const session = { warnings: new WarningLedger() };

	server.registerTool(
		"list_page_objects",
		{
			title: "List page objects",
			description: LIST_DESCRIPTION,
			inputSchema: listPageObjectsInput,
			annotations: READ_ONLY,
		},
		safeHandler((args) => handleListPageObjects(getWorkspace(), args, session)),
	);

	server.registerTool(
		"get_page_object_tree",
		{
			title: "Get page-object selector tree",
			description: TREE_DESCRIPTION,
			inputSchema: getPageObjectTreeInput,
			annotations: READ_ONLY,
			_meta: LARGE_RESULT,
		},
		safeHandler((args) =>
			handleGetPageObjectTree(getWorkspace(), args, session),
		),
	);

	server.registerTool(
		"get_testid_tree",
		{
			title: "Get rendered test-id tree",
			description: TESTID_DESCRIPTION,
			inputSchema: getTestIdTreeInput,
			annotations: READ_ONLY,
		},
		safeHandler((args) => handleGetTestIdTree(getWorkspace(), args, session)),
	);

	server.registerTool(
		"map_coverage",
		{
			title: "Map selector/test-id coverage",
			description: COVERAGE_DESCRIPTION,
			inputSchema: mapCoverageInput,
			annotations: READ_ONLY,
			_meta: LARGE_RESULT,
		},
		safeHandler((args) =>
			handleMapCoverage(getWorkspace(), args, {
				assumeForwarded: options.assumeForwarded,
				handles,
				warnings: session.warnings,
			}),
		),
	);

	server.registerTool(
		"query_coverage",
		{
			title: "Page a coverage report",
			description: QUERY_DESCRIPTION,
			inputSchema: queryCoverageInput,
			annotations: READ_ONLY,
			_meta: LARGE_RESULT,
		},
		safeHandler((args) =>
			handleQueryCoverage(getWorkspace(), args, handles, session),
		),
	);

	return server;
}
