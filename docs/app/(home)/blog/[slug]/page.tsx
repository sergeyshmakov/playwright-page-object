import { InlineTOC } from "fumadocs-ui/components/inline-toc";
import { DocsBody } from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/components/mdx";
import { authors, tagSlug } from "@/lib/blog";
import { absoluteUrl, repositoryUrl, siteName } from "@/lib/site";
import { blog, pageTitle } from "@/lib/source";

type PageProperties = {
	params: Promise<{ slug: string }>;
};

export default async function BlogPostPage(props: PageProperties) {
	const { slug } = await props.params;
	const page = blog.getPage([slug]);
	if (!page) notFound();

	const MDX = page.data.body;
	const author = authors[page.data.authors as keyof typeof authors];
	const updated = page.data.lastUpdated ?? page.data.date;

	return (
		<main className="mx-auto w-full max-w-5xl flex-1 px-6 py-14 sm:py-20">
			<header className="border-b pb-8">
				<Link
					href="/blog/"
					className="text-sm text-fd-muted-foreground hover:underline"
				>
					← Blog
				</Link>
				<h1 className="mt-5 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
					{page.data.title}
				</h1>
				<p className="mt-5 max-w-3xl text-lg leading-8 text-fd-muted-foreground">
					{page.data.description}
				</p>
				<div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-fd-muted-foreground">
					{author && (
						<Link
							href={`/blog/authors/${author.slug}/`}
							className="hover:underline"
						>
							{author.name}
						</Link>
					)}
					<time dateTime={page.data.date}>
						{new Date(`${page.data.date}T00:00:00Z`).toLocaleDateString(
							"en-US",
							{ dateStyle: "long", timeZone: "UTC" },
						)}
					</time>
					<a
						href={`${repositoryUrl}/edit/main/docs/content/blog/${page.path}`}
						target="_blank"
						rel="noreferrer noopener"
						className="hover:underline"
					>
						Edit on GitHub
					</a>
				</div>
				<div className="mt-5 flex flex-wrap gap-2">
					{page.data.tags.map((tag) => (
						<Link
							key={tag}
							href={`/blog/tags/${tagSlug(tag)}/`}
							className="rounded-full border px-2.5 py-1 text-xs text-fd-muted-foreground hover:text-fd-foreground"
						>
							{tag}
						</Link>
					))}
				</div>
			</header>

			<article className="mt-10">
				<InlineTOC items={page.data.toc} />
				<DocsBody className="mt-10">
					<MDX
						components={getMDXComponents({
							a: createRelativeLink(blog, page),
						})}
					/>
				</DocsBody>
			</article>

			<p className="mt-12 border-t pt-6 text-sm text-fd-muted-foreground">
				Last updated{" "}
				{new Date(`${updated}T00:00:00Z`).toLocaleDateString("en-US", {
					dateStyle: "long",
					timeZone: "UTC",
				})}
			</p>
		</main>
	);
}

export function generateStaticParams() {
	return blog.getPages().map((page) => ({ slug: page.slugs[0] }));
}

export async function generateMetadata(
	props: PageProperties,
): Promise<Metadata> {
	const { slug } = await props.params;
	const page = blog.getPage([slug]);
	if (!page) notFound();

	const canonical = absoluteUrl(page.url).toString();
	const title = pageTitle(page.data);
	const customTitle = title !== page.data.title;

	return {
		title: customTitle ? { absolute: title } : page.data.title,
		description: page.data.description,
		alternates: { canonical },
		openGraph: {
			type: "article",
			siteName,
			title,
			description: page.data.description,
			url: canonical,
			publishedTime: `${page.data.date}T00:00:00.000Z`,
		},
	};
}
