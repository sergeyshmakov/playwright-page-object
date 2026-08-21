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
	"/blog/playwright-page-object-mcp-server/",
	"/blog/tags/ai-agents/",
	"/blog/tags/e2e/",
	"/blog/tags/mcp/",
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
	[
		"/blog/tags/page-object-model/",
		"Page Object Model | playwright-page-object",
	],
	["/blog/tags/playwright/", "Playwright | playwright-page-object"],
	["/blog/tags/test-automation/", "Test Automation | playwright-page-object"],
	["/blog/tags/typescript/", "TypeScript | playwright-page-object"],
	[
		"/blog/playwright-page-object-mcp-server/",
		"Why AI Agents Guess Playwright Selectors | POM MCP",
	],
	[
		"/blog/typed-playwright-page-objects/",
		"How to Build Typed Playwright Page Objects with Decorators | playwright-page-object",
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
}

for (const file of [
	path.join("out", "404.html"),
	path.join("out", "favicon.svg"),
	path.join("out", "google9835a2061220351a.html"),
	path.join("out", "logo.svg"),
	path.join("out", "robots.txt"),
	path.join("out", "blog", "rss.xml"),
]) {
	if (!existsSync(file)) throw new Error(`missing static output: ${file}`);
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
