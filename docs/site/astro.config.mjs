// fleetd.sh/docs. Built into site/docs/, which is committed: the Vercel project serves site/ as is, and its build
// only generates the search index, site/docs/pagefind (ignored). Source format and commands: site/README.md ("Docs").
import { satteri } from "@astrojs/markdown-satteri";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://fleetd.sh",
  base: "/docs",
  outDir: "../../site/docs",
  // Vercel's cleanUrls serves docs/<page>.html at /docs/<page>, the URLs the docs have always had.
  build: { format: "file" },
  trailingSlash: "never",
  // `## Remove a machine {#remove}`: anchors that other pages and fleetd's own output link to stay put when a
  // heading's wording changes.
  markdown: { processor: satteri({ features: { headingAttributes: true } }) },
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
      head: [
        { tag: "link", attrs: { rel: "preload", href: "/fonts/plex-sans-Regular.woff2", as: "font", type: "font/woff2", crossorigin: "" } },
        { tag: "link", attrs: { rel: "preload", href: "/fonts/plex-sans-Medium.woff2", as: "font", type: "font/woff2", crossorigin: "" } },
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
        { label: "Get started", items: ["install", "quick-start", "concepts"] },
        {
          label: "Use fleetd",
          items: [
            "machines",
            "projects",
            "navi",
            "chat",
            "merge-train",
            "github",
            "steering",
            "automations",
            "approvals-and-secrets",
            "people",
            "desktop-app",
            "phone-notifications",
            "several-hubs",
            "status",
            "time-inspector",
            "what-agents-are-told",
            "mcp-servers",
            "integrations",
            "google",
            "skills",
            "browser-sessions",
            "mcp-clients",
          ],
        },
        {
          label: "Reference",
          items: ["reference/cli", "reference/agent-tools", "config-and-files", "security", "glossary"],
        },
        { label: "Help", items: ["troubleshooting", "updating-and-uninstall"] },
      ],
    }),
  ],
});
