import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Provider } from "@/components/provider";
import { ogImage } from "@/lib/og";
import { siteDescription, siteName, siteUrl } from "@/lib/site";
import "./global.css";

export const metadata: Metadata = {
	metadataBase: new URL(siteUrl),
	title: {
		default: siteName,
		template: `%s | ${siteName}`,
	},
	description: siteDescription,
	icons: {
		icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
	},
	alternates: {
		canonical: "/",
	},
	openGraph: {
		type: "website",
		siteName,
		title: siteName,
		description: siteDescription,
		url: "/",
		images: [ogImage],
	},
	twitter: {
		card: "summary_large_image",
		title: siteName,
		description: siteDescription,
		images: [ogImage],
	},
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<body className="flex min-h-screen flex-col antialiased">
				<Provider>{children}</Provider>
			</body>
		</html>
	);
}
