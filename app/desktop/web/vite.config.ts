// The design preview: the renderer in a plain browser, with a fixture standing in for the hub and web/stand-in.ts for
// the preload, so a design can be clicked through with no Electron and no hub. Only this config loads web/;
// electron-vite's builds never see it. `PORT=5180 HOST=0.0.0.0 pnpm exec vite -c web/vite.config.ts`.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const desktopDir = resolve(import.meta.dirname, "..");
const fixturesDir = resolve(desktopDir, "fixtures");
const standIn = resolve(import.meta.dirname, "stand-in.ts");

const CSP_WEB =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'self'";

const fixtureNames = (): string[] => {
  try {
    return readdirSync(fixturesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
};

const webPreview = (): Plugin => ({
  name: "fleetd-web-preview",
  apply: "serve",
  transformIndexHtml: {
    order: "pre",
    handler: (html) =>
      html
        .replace(/(http-equiv="Content-Security-Policy"\s+content=")[^"]*"/u, `$1${CSP_WEB}"`)
        .replace(/<script type="module" src="\.\/src\/main\.tsx"><\/script>/u, `<script type="module" src="/@fs${standIn}"></script>`),
  },
  configureServer: (server) => {
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
  resolve: { alias: [{ find: /^node:(fs|path)$/u, replacement: resolve(import.meta.dirname, "node-stub.ts") }] },
  // Every dependency found before the first page loads: a dependency met later re-bundles them all, and with no HMR a
  // module the page is still fetching then fails to load.
  optimizeDeps: { include: ["zod"], entries: [standIn, "index.html", "src/**/*.{ts,tsx}", "screens/**/*.{ts,tsx}", "ui/**/*.{ts,tsx}", "!**/*.test.{ts,tsx}"] },
  server: {
    host: process.env["HOST"] ?? "127.0.0.1",
    port: Number(process.env["PORT"] ?? "5180"),
    strictPort: true,
    allowedHosts: true,
    hmr: false,
    fs: { allow: [desktopDir] },
  },
});
