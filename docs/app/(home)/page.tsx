import { highlight } from "fumadocs-core/highlight";
import { Card, Cards } from "fumadocs-ui/components/card";
import { CodeBlock } from "fumadocs-ui/components/codeblock";
import type { Metadata } from "next";
import Link from "next/link";
import { npmUrl, repositoryUrl, siteDescription } from "@/lib/site";

const beforeCode = `await page.getByTestId("CheckoutPage")
  .getByTestId("PromoCodeInput").fill("SAVE20");
await page.getByTestId("CheckoutPage")
  .getByRole("button", { name: "Apply" }).click();`;

const afterCode = `await checkoutPage.applyPromoCode("SAVE20");`;

export const metadata: Metadata = {
	title: "playwright-page-object",
	description: siteDescription,
	alternates: {
		canonical: "/",
	},
};

export default async function HomePage() {
	const [beforeHighlighted, afterHighlighted] = await Promise.all([
		highlight(beforeCode, { lang: "ts" }),
		highlight(afterCode, { lang: "ts" }),
	]);

	return (
		<main className="relative flex flex-1 flex-col overflow-hidden">
			<div
				aria-hidden
				className="pom-hero-grid pointer-events-none absolute inset-0 opacity-70"
			/>
			<section className="relative mx-auto w-full max-w-6xl px-6 py-20 sm:py-28">
				<div className="grid items-center gap-12 lg:grid-cols-[minmax(0,12fr)_minmax(0,8fr)]">
					<div>
						<h1 className="max-w-4xl text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
							Typed Page Objects for Playwright
						</h1>
						<p className="mt-6 max-w-3xl text-pretty text-lg leading-8 text-fd-muted-foreground sm:text-xl">
							Decorator-driven, lazy locator chains in plain TypeScript classes.
						</p>
						<div className="mt-9 flex flex-wrap gap-3">
							<Link
								href="/getting-started/quick-start/"
								className="rounded-lg bg-fd-primary px-5 py-3 font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
							>
								Quick Start
							</Link>
							<Link
								href="/mcp/"
								className="rounded-lg border bg-fd-background px-5 py-3 font-medium transition-colors hover:bg-fd-accent"
							>
								MCP Server
							</Link>
							<a
								href={repositoryUrl}
								rel="noreferrer noopener"
								target="_blank"
								className="rounded-lg border bg-fd-background px-5 py-3 font-medium transition-colors hover:bg-fd-accent"
							>
								View on GitHub
							</a>
							<a
								href={npmUrl}
								rel="noreferrer noopener"
								target="_blank"
								className="rounded-lg border bg-fd-background px-5 py-3 font-medium transition-colors hover:bg-fd-accent"
							>
								View on npm
							</a>
						</div>
					</div>
					{/* The logo's own grammar at hero scale: outlined squares that
					    nest, each holding the element it resolves to. Opacity carries
					    the depth, so it needs no dark-mode variant. */}
					<img
						src="/hero.svg"
						alt="Abstract nested page objects, each resolving to an element"
						width={440}
						height={440}
						loading="eager"
						decoding="async"
						className="mx-auto hidden h-auto w-full max-w-sm lg:block"
					/>
				</div>

				<div className="mt-16 grid items-start gap-5 lg:grid-cols-2">
					<CodeBlock
						title="Before — selectors duplicated, structure invisible"
						className="my-0"
					>
						{beforeHighlighted}
					</CodeBlock>
					<CodeBlock
						title="After — typed, composable, reusable"
						className="my-0"
					>
						{afterHighlighted}
					</CodeBlock>
				</div>

				<section className="mt-16">
					<h2 className="text-3xl font-semibold tracking-tight">
						MCP server for AI coding agents
					</h2>
					<p className="mt-4 max-w-4xl leading-7 text-fd-muted-foreground">
						The local, read-only MCP server lets coding agents inspect existing
						page objects and JSX or TSX test IDs before editing tests.
					</p>
					<Cards className="mt-6">
						<Card
							title="Reuse existing test APIs"
							description="Follow typed locator chains instead of guessing method names."
						/>
						<Card
							title="Find real test IDs"
							description="Read statically declared test IDs before writing selectors."
						/>
						<Card
							title="Audit selector coverage"
							description="Find uncovered IDs, dead selectors, and uncertain matches."
						/>
					</Cards>
					<p className="mt-5">
						<Link
							href="/mcp/"
							className="font-medium underline underline-offset-4"
						>
							Explore the MCP server docs →
						</Link>
					</p>
				</section>

				<section className="mt-16">
					<h2 className="text-3xl font-semibold tracking-tight">
						Three output styles
					</h2>
					<Cards className="mt-6">
						<Card
							title="Raw Locator"
							description="Minimal abstraction with typed Locator properties."
							href="/guides/plain-classes/"
						/>
						<Card
							title="Custom Controls"
							description="Wrap selectors in your own typed control classes."
							href="/guides/custom-controls/"
						/>
						<Card
							title="Built-In POM"
							description="Use PageObject and ListPageObject helpers."
							href="/guides/built-in-pom/"
						/>
					</Cards>
				</section>

				<section className="mt-16">
					<h2 className="text-3xl font-semibold tracking-tight">Next steps</h2>
					<Cards className="mt-6">
						<Card title="Install" href="/getting-started/installation/" />
						<Card title="Quick start" href="/getting-started/quick-start/" />
						<Card
							title="Choose a style"
							href="/getting-started/choosing-a-style/"
						/>
						<Card title="API reference" href="/api/decorators/" />
					</Cards>
				</section>
			</section>
		</main>
	);
}
