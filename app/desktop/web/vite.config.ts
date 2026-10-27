// `pnpm web:preview`: the renderer in a plain browser on 127.0.0.1:$PORT, with a fixture standing in for the hub and
// web/stand-in.ts for the preload, so a PR's screens can be clicked through with no Electron and no hub (Try it).
// Only this config loads the stand-in; electron-vite's build never sees web/.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const desktopDir = resolve(import.meta.dirname, "..");
const fixturesDir = resolve(desktopDir, "fixtures");
const standIn = resolve(import.meta.dirname, "stand-in.ts");

// index.html's CSP, opened only as far as a dev server needs: React Refresh's inline preamble and fetching fixtures.
const CSP_WEB =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'self'";

const fixtureNames = (): string[] => {
  try {
    return readdirSync(fixturesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .toSorted();
  } catch {
    return [];
  }
};

const webPreview = (): Plugin => ({
  name: "fleetd-web-preview",
  apply: "serve",
  // Before Vite's own transforms, which rewrite the entry's path differently for a URL with a query (?fixture=).
  transformIndexHtml: {
    order: "pre",
    handler: (html) =>
      html
        .replace(/(http-equiv="Content-Security-Policy"\s+content=")[^"]*"/u, `$1${CSP_WEB}"`)
        .replace(/<script type="module" src="\.\/src\/main\.tsx"><\/script>/u, `<script type="module" src="/@fs${standIn}"></script>`),
  },
  configureServer: (server) => {
    // The files `pnpm fixtures` wrote, as they are: it already checked each with main's own loader.
    server.middlewares.use("/@fleetd-web/", (req, res) => {
      const names = fixtureNames();
      const url = req.url ?? "";
      if (url === "/fixtures") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(names));
        return;
      }
      const name = /^\/fixture\/([a-z0-9-]+)$/u.exec(url)?.[1];
      if (name === undefined || !names.includes(name)) {
        res.statusCode = 404;
        res.end(names.length === 0 ? "No fixtures: run `pnpm fixtures` in app/desktop." : `No fixture ${url}.`);
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(readFileSync(resolve(fixturesDir, `${name}.json`)));
    });
  },
});

export default defineConfig({
  root: resolve(desktopDir, "src/renderer"),
  plugins: [react(), webPreview()],
  // The stand-in runs main's FixtureSource in the page; its file also loads fixtures from disk, which it never does here.
  resolve: { alias: [{ find: /^node:(fs|path)$/u, replacement: resolve(import.meta.dirname, "node-stub.ts") }] },
  server: {
    host: "127.0.0.1",
    port: Number(process.env["PORT"] ?? "5180"),
    strictPort: true,
    // Try it's proxy passes the person's Host (the node's tailnet name) through unchanged; the server listens on
    // 127.0.0.1 only, so the proxy is all that reaches it.
    allowedHosts: true,
    // A preview, not a dev loop: no socket to reconnect through a proxy.
    hmr: false,
    fs: { allow: [desktopDir] },
  },
});
