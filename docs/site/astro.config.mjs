// fleetd.sh/docs. Built into site/docs/ (ignored) by the Vercel build of site/, which then generates the search index,
// site/docs/pagefind. Source format and commands: site/README.md ("Docs").
import { satteri } from "@astrojs/markdown-satteri";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { oldAnchorScript } from "./src/old-anchors.mjs";

// Every table sits in its own box that scrolls sideways when the table is wider than the page, so a wide table on a
// phone scrolls inside the box instead of being cut off at the page's edge.
const tableScroll = {
  name: "table-scroll",
  element: {
    filter: ["table"],
    visit(node, ctx) {
      ctx.wrapNode(node, { type: "element", tagName: "div", properties: { className: ["table-scroll"] }, children: [] });
    },
  },
};

export default defineConfig({
  site: "https://fleetd.sh",
  base: "/docs",
  outDir: "../../site/docs",
  // Vercel's cleanUrls serves docs/<page>.html at /docs/<page>, the URLs the docs have always had.
  build: { format: "file" },
  trailingSlash: "never",
  // `## Remove a machine {#remove}`: anchors that other pages and fleetd's own output link to stay put when a
  // heading's wording changes.
  markdown: { processor: satteri({ features: { headingAttributes: true }, hastPlugins: [tableScroll] }) },
  integrations: [
    starlight({
      title: "fleetd docs",
      description: "fleetd runs Claude Code on your own machines.",
      favicon: "/favicon.svg",
      logo: { src: "./src/assets/icon.svg", alt: "" },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/unlaboredlabs/fleetd" }],
      editLink: { baseUrl: "https://github.com/unlaboredlabs/fleetd/edit/main/docs/site/" },
      // Vercel serves site/404 for the whole site; a /docs/404 page would never be reached.
      disable404Route: true,
      customCss: ["./src/styles/theme.css"],
      // Canonical links and og:url at the clean address, not the built .html file.
      routeMiddleware: "./src/route-data.ts",
      head: [
        // The site's link card (site/card.jpg, site/README.md), for the large card Starlight's twitter:card asks for.
        { tag: "meta", attrs: { property: "og:image", content: "https://fleetd.sh/card.jpg" } },
        { tag: "meta", attrs: { property: "og:image:width", content: "2400" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "1260" } },
        { tag: "link", attrs: { rel: "preload", href: "/fonts/plex-sans-Regular.woff2", as: "font", type: "font/woff2", crossorigin: "" } },
        { tag: "link", attrs: { rel: "preload", href: "/fonts/plex-sans-Medium.woff2", as: "font", type: "font/woff2", crossorigin: "" } },
        // Old links to a section that moved go on to where it lives now (src/old-anchors.mjs).
        { tag: "script", content: oldAnchorScript },
      ],
      // Code is a compact hairline panel in Lilex: no window chrome (a terminal frame's three dots), no shadow, a copy
      // button that shows on hover. Muted themes, so a block reads as text before it reads as colour.
      expressiveCode: {
        themes: ["vitesse-dark", "vitesse-light"],
        defaultProps: { frame: "code" },
        // A console block's output in the page's grey, under the command in ink, rather than the theme's blue.
        customizeTheme(theme) {
          for (const rule of theme.settings) {
            if (rule.scope?.includes("meta.output")) rule.settings.foreground = theme.type === "dark" ? "#a1a1a1" : "#626262";
          }
        },
        styleOverrides: {
          borderRadius: "8px",
          borderColor: "var(--sl-color-hairline)",
          codeBackground: "var(--fd-fill)",
          codeFontFamily: "var(--__sl-font-mono)",
          codeFontSize: "0.8125rem",
          codeLineHeight: "1.55",
          codePaddingBlock: "0.625rem",
          codePaddingInline: "0.875rem",
          uiFontFamily: "var(--__sl-font)",
          frames: {
            frameBoxShadowCssValue: "none",
            inlineButtonBorder: "var(--sl-color-hairline)",
            inlineButtonBackground: "var(--sl-color-black)",
            inlineButtonForeground: "var(--sl-color-gray-3)",
          },
        },
      },
      sidebar: [
        { label: "Get started", items: [{ label: "Home", link: "/" }, "quick-start", "install", "how-fleetd-works"] },
        {
          label: "Using a bot",
          items: [
            "chat",
            "steering",
            "bots",
            "models",
            "status",
            "agent-time",
            "payments-and-sign-ins",
            "people",
            "approvals-and-secrets",
            "vault",
            "automations",
            "skills",
            "memory",
          ],
        },
        {
          label: "Shipping code",
          items: ["github", "merge-train", "merge-train-ci", "issues", "what-agents-are-told", "mcp-servers", "mcp-clients", "connections"],
        },
        {
          label: "Machines & screens",
          items: ["machines", "cloud-machines", "billing", "agents-mac", "browser-sessions", "desktop-app", "several-hubs", "mobile", "web-app", "phone-notifications"],
        },
        {
          label: "Running a hub",
          items: ["config-and-files", "security", "moving-a-hub", "updating-and-uninstall", "releases", "troubleshooting"],
        },
        { label: "Reference", items: ["reference/cli", "reference/agent-tools", "glossary"] },
      ],
    }),
  ],
});
