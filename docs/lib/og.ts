import { ogImageAlt, ogImagePath } from "@/lib/site";

// One descriptor for the social card, imported by every route that declares
// openGraph metadata. Next resolves the relative path against metadataBase.
//
// The dimensions are not decorative: without width and height a crawler has to
// fetch and measure the image before it will show a large card, and several
// simply fall back to the small one instead.
export const ogImage = {
	url: ogImagePath,
	width: 1200,
	height: 630,
	alt: ogImageAlt,
} as const;
