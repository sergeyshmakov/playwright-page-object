// Single source of truth for the deployed site identity.
//
// Imported by astro.config.mjs (Astro's `site` / `base` and the blog author)
// and by scripts/postbuild-rss.mjs (RSS channel + self links), so the two
// can't drift. Change a value here and both the built site and the patched
// RSS feed pick it up. Update these together when moving to a custom domain.
export const SITE = "https://sergeyshmakov.github.io";
export const BASE = "/playwright-page-object";
export const AUTHOR_NAME = "Sergei Shmakov";
