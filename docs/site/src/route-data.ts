import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

// Pages are built as docs/<page>.html (build.format "file", astro.config.mjs) and served by Vercel's cleanUrls at
// /docs/<page>, which is where a page's canonical link, og:url, the site title, the sidebar and Previous/Next point: the .html address
// only redirects there, a round trip a click.
const clean = (href: string): string => href.replace(/\/index\.html$/u, "").replace(/\.html$/u, "");

type Entry = { type: "link"; href: string } | { type: "group"; entries: Entry[] };
const cleanSidebar = (entries: Entry[]) => {
  for (const e of entries) {
    if (e.type === "link") e.href = clean(e.href);
    else cleanSidebar(e.entries);
  }
};

export const onRequest = defineRouteMiddleware((context) => {
  for (const { tag, attrs } of context.locals.starlightRoute.head) {
    if (tag === "link" && attrs?.rel === "canonical" && typeof attrs.href === "string") attrs.href = clean(attrs.href);
    if (tag === "meta" && attrs?.property === "og:url" && typeof attrs.content === "string") attrs.content = clean(attrs.content);
  }
  const route = context.locals.starlightRoute;
  route.siteTitleHref = clean(route.siteTitleHref);
  cleanSidebar(route.sidebar as Entry[]);
  for (const link of [route.pagination.prev, route.pagination.next]) if (link !== undefined) link.href = clean(link.href);
});
