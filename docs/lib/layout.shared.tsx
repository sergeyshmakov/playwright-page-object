import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { npmUrl, repositoryUrl, siteName } from "@/lib/site";

export function baseOptions(): BaseLayoutProps {
	return {
		nav: {
			title: (
				<span className="flex items-center gap-2">
					<img src="/logo.svg" alt="" width={24} height={24} />
					<span>{siteName}</span>
				</span>
			),
		},
		githubUrl: repositoryUrl,
		links: [
			{
				text: "Documentation",
				url: "/getting-started/installation/",
				active: "nested-url",
			},
			{
				text: "MCP Server",
				url: "/mcp/",
				active: "nested-url",
			},
			{
				text: "Blog",
				url: "/blog/",
				active: "nested-url",
			},
			{
				text: "npm",
				url: npmUrl,
				external: true,
			},
		],
	};
}
