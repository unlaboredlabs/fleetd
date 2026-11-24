import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

// Pages are built as docs/<page>.html (build.format "file", astro.config.mjs) and served by Vercel's cleanUrls at
// /docs/<page>, which is where a page's canonical link and og:url point: the .html address only redirects there.
const clean = (href: string): string => href.replace(/\/index\.html$/u, "").replace(/\.html$/u, "");

export const onRequest = defineRouteMiddleware((context) => {
  for (const { tag, attrs } of context.locals.starlightRoute.head) {
    if (tag === "link" && attrs?.rel === "canonical" && typeof attrs.href === "string") attrs.href = clean(attrs.href);
    if (tag === "meta" && attrs?.property === "og:url" && typeof attrs.content === "string") attrs.content = clean(attrs.content);
  }
});
