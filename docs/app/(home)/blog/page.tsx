import type { Metadata } from "next";
import { BlogList } from "@/components/blog-list";
import { getPosts } from "@/lib/blog";
import { siteDescription } from "@/lib/site";

export const metadata: Metadata = {
	title: "Blog",
	description: siteDescription,
	alternates: {
		canonical: "/blog/",
	},
};

export default function BlogPage() {
	return (
		<main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16 sm:py-20">
			<h1 className="text-4xl font-semibold tracking-tight">Blog</h1>
			<p className="mt-4 max-w-3xl text-lg text-fd-muted-foreground">
				Practical Playwright Page Object Model patterns, TypeScript guidance,
				and AI-assisted test automation workflows.
			</p>
			<div className="mt-10">
				<BlogList posts={getPosts()} />
			</div>
		</main>
	);
}
