import { loader } from "fumadocs-core/source";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineCollections, defineDocs } from "fumadocs-mdx/macro";
import { z } from "zod";

const headSchema = z.array(
	z.object({
		tag: z.literal("title"),
		content: z.string(),
	}),
);

const documentation = defineDocs({
	dir: "content/docs",
	docs: {
		lastModified: true,
		schema: pageSchema.extend({
			head: headSchema.optional(),
			sidebar: z
				.object({
					label: z.string(),
				})
				.optional(),
		}),
	},
	meta: {
		schema: metaSchema,
	},
});

const blogPosts = defineCollections({
	type: "doc",
	dir: "content/blog",
	lastModified: true,
	postprocess: {
		includeMDAST: true,
	},
	schema: pageSchema.extend({
		head: headSchema.optional(),
		date: z.string().date(),
		lastUpdated: z.string().date().optional(),
		authors: z.string(),
		tags: z.array(z.string()),
	}),
});

export const source = loader({
	baseUrl: "/",
	source: documentation.toFumadocsSource(),
	plugins: ({ typedPlugin }) => [
		typedPlugin({
			transformPageTree: {
				file(node, file) {
					if (!file) return node;
					const entry = this.storage.read(file);
					const label =
						entry && "sidebar" in entry.data
							? entry.data.sidebar?.label
							: undefined;
					if (label) node.name = label;
					return node;
				},
			},
		}),
	],
});

export const blog = loader({
	baseUrl: "/blog",
	source: blogPosts.toFumadocsSource(),
});

export function pageTitle(data: {
	title: string;
	head?: Array<{ tag: "title"; content: string }>;
}) {
	return (
		data.head?.find((entry) => entry.tag === "title")?.content ?? data.title
	);
}
