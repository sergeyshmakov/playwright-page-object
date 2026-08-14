import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightBlog from "starlight-blog";
import { AUTHOR_NAME, BASE, SITE } from "./site.config.mjs";

const REPO_URL = "https://github.com/sergeyshmakov/playwright-page-object";

/**
 * Copy the heading's URL when its anchor icon is clicked, and confirm it by
 * swapping the link glyph for a tick for three seconds.
 *
 * Delegated from `document` rather than bound per heading: it costs one
 * listener, covers headings Starlight renders on any page, and survives soft
 * navigation without rebinding. The default jump is left alone, so the address
 * bar ends up showing exactly what was copied.
 *
 * The icon is restored from the markup it replaced rather than re-rendered, so
 * this stays correct if Starlight changes its own glyph. `data-copied` both
 * guards against a second click mid-timeout and drives the CSS that keeps the
 * anchor visible — without it the tick disappears the moment the pointer
 * leaves the heading, since Starlight reveals the link on hover alone.
 */
const ANCHOR_COPY_SCRIPT = `(() => {
	const TICK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
	const RESTORE_MS = 3000;
	let live;
	document.addEventListener("click", (event) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const link = target.closest("a.sl-anchor-link");
		if (!link || !navigator.clipboard) return;
		const icon = link.querySelector(".sl-anchor-icon");
		if (!icon || icon.dataset.copied === "true") return;
		const url = new URL(link.getAttribute("href"), location.href).href;
		navigator.clipboard.writeText(url).then(() => {
			const original = icon.innerHTML;
			icon.dataset.copied = "true";
			icon.innerHTML = TICK;
			if (!live) {
				live = document.createElement("div");
				live.className = "sr-only";
				live.setAttribute("aria-live", "polite");
				document.body.appendChild(live);
			}
			live.textContent = "Link copied";
			setTimeout(() => {
				icon.innerHTML = original;
				delete icon.dataset.copied;
				live.textContent = "";
			}, RESTORE_MS);
		}).catch(() => {});
	});
})();`;

export default defineConfig({
	site: SITE,
	base: BASE,
	integrations: [
		starlight({
			title: "playwright-page-object",
			description:
				"Typed, decorator-driven Page Object Model for Playwright. Reusable, lazy locator chains in plain TypeScript classes.",
			customCss: ["./src/styles/custom.css"],
			head: [{ tag: "script", content: ANCHOR_COPY_SCRIPT }],
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
			plugins: [
				starlightBlog({
					title: "Blog",
					authors: {
						sergei: {
							name: AUTHOR_NAME,
							url: "https://github.com/sergeyshmakov",
							picture: "https://github.com/sergeyshmakov.png",
						},
					},
				}),
			],
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
					label: "MCP Server",
					items: [
						"mcp",
						"mcp/quick-start",
						"mcp/workflows",
						"mcp/tools",
						"mcp/configuration",
						"mcp/limitations",
						"mcp/monorepos",
						"mcp/troubleshooting",
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
