import * as z from "zod";

/**
 * Tool input schemas (zod v4). No `.refine()` anywhere — refinements are not
 * representable in the JSON Schema sent to clients; cross-field rules are
 * validated in handlers where they can produce actionable hints instead.
 */

export const listPageObjectsInput = z.object({
	filter: z
		.string()
		.optional()
		.describe(
			'Case-insensitive substring matched against class name and file path, e.g. "checkout".',
		),
	limit: z.number().int().min(1).max(500).default(100),
	offset: z
		.number()
		.int()
		.min(0)
		.default(0)
		.describe(
			"Index of the first entry to return, applied after filter. meta.total always reports the full count and meta.nextOffset the value to pass for the next page.",
		),
});

export const getPageObjectTreeInput = z.object({
	class: z
		.string()
		.optional()
		.describe('Class name, e.g. "CheckoutPage". Provide class, file, or both.'),
	file: z
		.string()
		.optional()
		.describe(
			"Path to the file, relative to the project root. An absolute path inside the project root is accepted and relativized (meta.note says so); one outside it is rejected. Use with class when a name is ambiguous; alone it resolves to the file's default-exported (else first root) page object, and errors with candidates when neither applies.",
		),
	depth: z
		.number()
		.int()
		.min(1)
		.max(10)
		.default(3)
		.describe("How many levels of nested control classes to expand."),
	includeMethods: z.boolean().default(true),
	format: z
		.enum(["json", "outline"])
		.default("json")
		.describe(
			'"outline" returns an indented text tree (fewer tokens, not machine-parseable).',
		),
});

export const getTestIdTreeInput = z.object({
	file: z
		.string()
		.optional()
		.describe(
			"Component file to use as the tree root, path relative to the project root (a leading ./ and Windows separators are accepted; an absolute path inside the root is relativized and meta.note says so). Combine with component to pick one of several files declaring that name. A path matching no scanned .tsx/.jsx source fails with file_not_found and suggestions rather than silently walking the whole app.",
		),
	component: z
		.string()
		.optional()
		.describe('Component name, e.g. "CheckoutPage".'),
	testId: z
		.string()
		.optional()
		.describe(
			"Look up where this test id is rendered instead of walking a component tree.",
		),
	depth: z.number().int().min(1).max(10).default(4),
	followComponents: z
		.boolean()
		.default(true)
		.describe(
			"Inline the subtrees of child components imported from other files.",
		),
	attribute: z
		.string()
		.optional()
		.describe(
			'Test-id attribute name, e.g. "data-tid". Defaults to the server-resolved attribute.',
		),
	format: z.enum(["json", "outline"]).default("json"),
});

/** The six lists `map_coverage` can return, as a `buckets` enum. */
export const COVERAGE_BUCKETS = [
	"matched",
	"uncoveredTestIds",
	"deadSelectors",
	"nonTestIdSelectors",
	"unknownSelectors",
	"unknownTestIds",
] as const;

export const mapCoverageInput = z.object({
	class: z
		.string()
		.optional()
		.describe(
			"Narrow the page-object side to the file that declares this class. Page objects sharing that file are included too; meta.alsoIncluded names them.",
		),
	file: z
		.string()
		.optional()
		.describe(
			"Limit the page-object side to one file, path relative to the project root exactly as list_page_objects reports it (a leading ./ and Windows separators are accepted). A path that declares no page object fails with file_not_found rather than reporting everything as uncovered.",
		),
	attribute: z.string().optional(),
	includeUnused: z
		.boolean()
		.default(true)
		.describe(
			"Include uncoveredTestIds (rendered ids no page object uses). Set false for a shorter response. Ignored when buckets is given.",
		),
	includeRawLocators: z
		.boolean()
		.default(false)
		.describe(
			"Also scan the sources for direct getByTestId / getItemByTestId / filterByItemTestId / filterByHasTestId calls. Off by default, so an id under uncoveredTestIds means no page object selects it - not that it is untested. Turn on before concluding a test id is unused.",
		),
	buckets: z
		.array(z.enum(COVERAGE_BUCKETS))
		.optional()
		.describe(
			"Return only these lists. summary and scope always ship, so [] returns just those two. Wins over includeUnused, which is then echoed in meta.ignored.",
		),
	// 50, not 200: six buckets at 200 is half a megabyte on a large repository,
	// and the default call is the one an agent makes before it knows the shape
	// of the answer. At 50 a whole-project report fits, and `offset` pages the
	// bucket that turns out to matter. Measured on a 4,924-file app: 527 KB
	// rejected at 200, 145 KB returned at 50.
	limit: z
		.number()
		.int()
		.min(1)
		.max(1000)
		.default(50)
		.describe(
			"Entries per returned bucket. Bucket totals always ship in summary, so a capped list still tells you how much it is hiding; page the rest with offset.",
		),
	offset: z
		.number()
		.int()
		.min(0)
		.default(0)
		.describe(
			'Index of the first entry to return, applied to every returned bucket. To page a long list, prefer query_coverage with meta.coverageId; buckets:["unknownTestIds"] + offset works too but is not checked against the snapshot the first page came from. Bucket totals are always in summary, whatever this call returns.',
		),
});

export const queryCoverageInput = z.object({
	coverageId: z
		.string()
		.min(1)
		.describe(
			"Opaque handle from a previous map_coverage call (meta.coverageId). Carries that call's class / file / attribute / includeRawLocators scope, so none of them is restated here.",
		),
	bucket: z
		.enum(COVERAGE_BUCKETS)
		.describe(
			"The single list to page. One bucket at a time is what pages cleanly: offset then means one thing.",
		),
	offset: z
		.number()
		.int()
		.min(0)
		.default(0)
		.describe(
			"Index of the first entry to return. Pass meta.nextOffset from the previous page; when that key is absent the list is exhausted.",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(1000)
		.default(50)
		.describe(
			"Entries to return. A page that would still exceed the response cap is cut further and meta.truncatedBuckets says so.",
		),
});
