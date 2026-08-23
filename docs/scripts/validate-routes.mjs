import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const SITE = "https://pom.shmakov.tools";

const routes = [
	"/",
	"/ai-tooling/agent-skills/",
	"/ai-tooling/context7/",
	"/ai-tooling/cubic-wiki/",
	"/api/create-fixtures/",
	"/api/decorators/",
	"/api/list-page-object/",
	"/api/page-object/",
	"/api/root-page-object/",
	"/blog/",
	"/blog/authors/sergei-shmakov/",
	"/blog/openspec-playwright-tests-ai-agents/",
	"/blog/playwright-page-object-mcp-server/",
	"/blog/tags/ai-agents/",
	"/blog/tags/e2e/",
	"/blog/tags/mcp/",
	"/blog/tags/openspec/",
	"/blog/tags/page-object-model/",
	"/blog/tags/playwright/",
	"/blog/tags/test-automation/",
	"/blog/tags/typescript/",
	"/blog/typed-playwright-page-objects/",
	"/getting-started/choosing-a-style/",
	"/getting-started/installation/",
	"/getting-started/quick-start/",
	"/guides/built-in-pom/",
	"/guides/custom-controls/",
	"/guides/fixtures/",
	"/guides/fragments/",
	"/guides/incremental-adoption/",
	"/guides/lists/",
	"/guides/page-only-hosts/",
	"/guides/plain-classes/",
	"/mcp/",
	"/mcp/configuration/",
	"/mcp/limitations/",
	"/mcp/monorepos/",
	"/mcp/quick-start/",
	"/mcp/tools/",
	"/mcp/troubleshooting/",
	"/mcp/workflows/",
	"/reference/context-resolution/",
	"/reference/migration-v1-to-v2/",
	"/reference/troubleshooting/",
];

const exactTitles = new Map([
	["/", "playwright-page-object | playwright-page-object"],
	["/blog/", "Blog | playwright-page-object"],
	["/blog/authors/sergei-shmakov/", "Sergei Shmakov | playwright-page-object"],
	["/blog/tags/ai-agents/", "AI Agents | playwright-page-object"],
	["/blog/tags/e2e/", "E2E | playwright-page-object"],
	["/blog/tags/mcp/", "MCP | playwright-page-object"],
	["/blog/tags/openspec/", "OpenSpec | playwright-page-object"],
	[
		"/blog/tags/page-object-model/",
		"Page Object Model | playwright-page-object",
	],
	["/blog/tags/playwright/", "Playwright | playwright-page-object"],
	["/blog/tags/test-automation/", "Test Automation | playwright-page-object"],
	["/blog/tags/typescript/", "TypeScript | playwright-page-object"],
	[
		"/blog/openspec-playwright-tests-ai-agents/",
		"OpenSpec to Playwright tests with AI agents",
	],
	[
		"/blog/playwright-page-object-mcp-server/",
		"Why AI agents guess Playwright selectors | POM MCP",
	],
	[
		"/blog/typed-playwright-page-objects/",
		"How to build typed Playwright page objects with decorators | playwright-page-object",
	],
	["/mcp/", "Playwright Page Object MCP Server | playwright-page-object"],
	["/mcp/configuration/", "Playwright Page Object MCP Configuration"],
	["/mcp/limitations/", "Playwright Page Object MCP Limitations"],
	["/mcp/monorepos/", "Playwright Page Object MCP in Monorepos"],
	["/mcp/quick-start/", "Playwright Page Object MCP Setup Guide"],
	["/mcp/tools/", "Playwright Page Object MCP Tool Reference"],
	["/mcp/troubleshooting/", "Playwright Page Object MCP Troubleshooting"],
	["/mcp/workflows/", "Playwright Page Object MCP Workflow Guide"],
]);

const exactHeadings = new Map([
	[
		"/blog/openspec-playwright-tests-ai-agents/",
		"From OpenSpec to Playwright tests with AI agents",
	],
	[
		"/blog/playwright-page-object-mcp-server/",
		"Why AI agents guess Playwright selectors and how MCP helps",
	],
	[
		"/blog/typed-playwright-page-objects/",
		"How to build typed Playwright page objects with decorators",
	],
]);

const faqAnchors = new Map([
	[
		"/blog/openspec-playwright-tests-ai-agents/",
		[
			"does-openspec-generate-playwright-tests",
			"are-test-ids-required-for-playwright-tests-with-ai-agents",
			"is-this-the-same-as-playwright-test-agents",
			"can-mcp-coverage-replace-running-playwright",
			"when-should-the-openspec-change-be-archived",
		],
	],
	[
		"/blog/playwright-page-object-mcp-server/",
		[
			"does-the-mcp-server-work-with-data-tid-or-other-custom-attributes",
			"does-it-execute-my-code-or-launch-a-browser",
			"do-i-need-the-playwright-page-object-decorators-for-it-to-be-useful",
			"which-mcp-clients-does-it-support",
			"does-it-work-in-a-monorepo",
			"how-fresh-are-the-results",
		],
	],
	[
		"/blog/typed-playwright-page-objects/",
		[
			"is-playwright-page-object-a-framework-or-a-library",
			"does-it-work-with-the-standard-playwrighttest-runner",
			"what-is-the-typescript-accessor-keyword",
			"do-i-need-experimentaldecorators-in-my-tsconfig",
			"can-i-use-playwright-page-objects-without-inheritance",
			"does-this-reduce-flaky-playwright-tests",
		],
	],
]);

function fileForRoute(route) {
	if (route === "/") return path.join("out", "index.html");
	return path.join("out", ...route.split("/").filter(Boolean), "index.html");
}

function match(html, expression, label, route) {
	const result = expression.exec(html)?.[1];
	if (!result) throw new Error(`${route}: missing ${label}`);
	return result;
}

for (const route of routes) {
	const file = fileForRoute(route);
	if (!existsSync(file)) throw new Error(`${route}: expected ${file}`);
	const html = await readFile(file, "utf8");
	const canonical = match(
		html,
		/<link rel="canonical" href="([^"]+)"/,
		"canonical URL",
		route,
	);
	if (canonical !== `${SITE}${route}`) {
		throw new Error(`${route}: canonical is ${canonical}`);
	}
	match(
		html,
		/<meta name="description" content="([^"]+)"/,
		"description",
		route,
	);

	const expectedTitle = exactTitles.get(route);
	if (expectedTitle) {
		const title = match(html, /<title>(.*?)<\/title>/, "title", route);
		if (title !== expectedTitle) {
			throw new Error(`${route}: title is ${title}; expected ${expectedTitle}`);
		}
	}

	const expectedHeading = exactHeadings.get(route);
	if (expectedHeading) {
		const heading = match(html, /<h1[^>]*>(.*?)<\/h1>/, "H1", route);
		if (heading !== expectedHeading) {
			throw new Error(
				`${route}: H1 is ${heading}; expected ${expectedHeading}`,
			);
		}
	}

	for (const anchor of faqAnchors.get(route) ?? []) {
		if (!html.includes(`id="${anchor}"`)) {
			throw new Error(`${route}: missing FAQ anchor #${anchor}`);
		}
	}
}

const mermaidRoute = "/blog/openspec-playwright-tests-ai-agents/";
const mermaidHtml = await readFile(fileForRoute(mermaidRoute), "utf8");
const mermaidMarkers = mermaidHtml.match(/data-mermaid-diagram="true"/g) ?? [];
const renderedMermaid =
	mermaidHtml.match(
		/data-mermaid-diagram="true"[^>]*><svg[\s\S]*?<\/svg><\/div>/g,
	) ?? [];
if (mermaidMarkers.length !== 1 || renderedMermaid.length !== 1) {
	throw new Error(
		`${mermaidRoute}: expected 1 server-rendered Mermaid diagram; found ${mermaidMarkers.length} markers and ${renderedMermaid.length} SVGs`,
	);
}

const workflowImage = "/images/blog/openspec-playwright-agent-workflow.webp";
if (!mermaidHtml.includes(`src="${workflowImage}"`)) {
	throw new Error(`${mermaidRoute}: missing workflow image ${workflowImage}`);
}

for (const file of [
	path.join("out", "404.html"),
	path.join("out", "favicon.svg"),
	path.join("out", "google9835a2061220351a.html"),
	path.join("out", "images", "blog", "openspec-playwright-agent-workflow.webp"),
	path.join("out", "hero.svg"),
	path.join("out", "logo.svg"),
	path.join("out", "og-default.png"),
	path.join("out", "robots.txt"),
	path.join("out", "sitemap.xml"),
	path.join("out", "blog", "rss.xml"),
]) {
	if (!existsSync(file)) throw new Error(`missing static output: ${file}`);
}

const robots = await readFile(path.join("out", "robots.txt"), "utf8");
if (!robots.includes(`Sitemap: ${SITE}/sitemap.xml`)) {
	throw new Error("robots.txt must advertise /sitemap.xml");
}

const sitemap = await readFile(path.join("out", "sitemap.xml"), "utf8");
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
	.map(([, url]) => url)
	.sort();
const expectedSitemapUrls = routes.map((route) => `${SITE}${route}`).sort();
if (JSON.stringify(sitemapUrls) !== JSON.stringify(expectedSitemapUrls)) {
	throw new Error(
		`sitemap URLs differ from public routes:\n${JSON.stringify(sitemapUrls, null, 2)}`,
	);
}

for (const file of [
	path.join("out", "favicon.svg"),
	path.join("out", "logo.svg"),
]) {
	const svg = await readFile(file, "utf8");
	const colors = [...svg.matchAll(/#[\da-f]{6}/gi)].map(([color]) =>
		color.toLowerCase(),
	);
	if (colors.length === 0 || colors.some((color) => color !== "#45ba4b")) {
		throw new Error(`${file}: expected #45ba4b as the only visible color`);
	}
}

if (existsSync(path.join("out", "docs", "index.html"))) {
	throw new Error(
		"unexpected /docs/ route: documentation must remain at the domain root",
	);
}

console.log(
	`Validated ${routes.length} canonical public routes and static assets.`,
);
