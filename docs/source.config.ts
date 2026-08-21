import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { defineConfig } from "fumadocs-mdx/config";

export default defineConfig({
	mdxOptions: {
		remarkPlugins: (plugins) => [remarkMdxMermaid, ...plugins],
	},
});
