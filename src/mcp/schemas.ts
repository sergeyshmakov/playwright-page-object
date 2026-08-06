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
			"Path to the file, relative to the project root. Use with class when a name is ambiguous; alone it resolves to the file's default-exported (else first root) page object, and errors with candidates when neither applies.",
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
			"Component file to use as the tree root. Combine with component to pick one of several files declaring that name.",
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
		.describe("Limit the page-object side to one file."),
	attribute: z.string().optional(),
	includeUnused: z
		.boolean()
		.default(true)
		.describe(
			"Include uncoveredTestIds (rendered ids no page object uses). Set false for a shorter response.",
		),
	limit: z.number().int().min(1).max(1000).default(200),
});
