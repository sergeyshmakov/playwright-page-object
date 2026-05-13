import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const REPO_URL = "https://github.com/sergeyshmakov/playwright-page-object";

export default defineConfig({
	site: "https://sergeyshmakov.github.io/playwright-page-object",
	base: "/playwright-page-object",
	integrations: [
		starlight({
			title: "playwright-page-object",
			description:
				"Typed, decorator-driven Page Object Model for Playwright. Reusable, lazy locator chains in plain TypeScript classes.",
			customCss: ["./src/styles/custom.css"],
			social: [{ icon: "github", label: "GitHub", href: REPO_URL }],
			editLink: {
				baseUrl: `${REPO_URL}/edit/main/docs/`,
			},
			lastUpdated: true,
			tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
			expressiveCode: {
				themes: ["github-dark", "github-light"],
				styleOverrides: { borderRadius: "0.375rem" },
			},
			sidebar: [
				{
					label: "Getting Started",
					items: [
						"getting-started/installation",
						"getting-started/quick-start",
						"getting-started/choosing-a-style",
					],
				},
				{
					label: "Guides",
					items: [
						"guides/plain-classes",
						"guides/page-only-hosts",
						"guides/fragments",
						"guides/custom-controls",
						"guides/built-in-pom",
						"guides/lists",
						"guides/fixtures",
						"guides/incremental-adoption",
					],
				},
				{
					label: "Reference",
					items: [
						"reference/context-resolution",
						"reference/migration-v1-to-v2",
						"reference/troubleshooting",
					],
				},
				{
					label: "API",
					items: [
						"api/decorators",
						"api/page-object",
						"api/root-page-object",
						"api/list-page-object",
						"api/create-fixtures",
					],
				},
				{
					label: "AI Tooling",
					items: [
						"ai-tooling/agent-skills",
						"ai-tooling/context7",
						"ai-tooling/cubic-wiki",
					],
				},
			],
		}),
	],
});
