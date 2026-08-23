export const siteName = "playwright-page-object";
export const siteDescription =
	"Typed, decorator-driven Page Object Model for Playwright. Reusable, lazy locator chains in plain TypeScript classes.";
export const siteUrl = "https://pom.shmakov.tools";
export const repositoryUrl =
	"https://github.com/sergeyshmakov/playwright-page-object";
export const npmUrl = "https://www.npmjs.com/package/playwright-page-object";
export const ogImagePath = "/og-default.png";
export const ogImageAlt =
	"playwright-page-object — typed page objects for Playwright";

export const authorName = "Sergei Shmakov";

export function absoluteUrl(path: string): URL {
	const url = new URL(path, siteUrl);
	if (!url.pathname.endsWith("/") && !url.pathname.includes(".")) {
		url.pathname += "/";
	}
	return url;
}
