// fleetd.sh/docs. Built into site/docs/, which is committed: the Vercel project serves site/ as is, with no build
// step. Source format and commands: site/README.md ("Docs").
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
      customCss: ["./src/styles/neutral.css"],
      expressiveCode: {
        themes: ["github-dark", "github-light"],
        styleOverrides: { borderRadius: "6px" },
      },
      sidebar: [
        { label: "Get started", items: ["install", "quick-start", "concepts"] },
        {
          label: "Use fleetd",
          items: [
            "machines",
            "projects",
            "chat",
            "merge-train",
            "steering",
            "approvals-and-secrets",
            "desktop-app",
            "status",
            "time-inspector",
            "what-agents-are-told",
            "mcp-servers",
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
