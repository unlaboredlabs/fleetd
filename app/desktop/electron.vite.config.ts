import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import { preloadChunks } from "./scripts/preloadChunks.ts";

const CSP_DEV =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'";

// The dev server needs the React Refresh inline preamble and the HMR socket; the built app keeps index.html's CSP.
const devCsp = (): Plugin => ({
  name: "fleetd-dev-csp",
  apply: "serve",
  transformIndexHtml: (html) => html.replace(/(http-equiv="Content-Security-Policy"\s+content=")[^"]*"/u, `$1${CSP_DEV}"`),
});

export default defineConfig({
  // zod and ws are bundled: loading zod's ESM build file by file took ~25 ms of startup, and ws's CommonJS files ~6 ms more.
  main: { build: { externalizeDeps: { exclude: ["zod", "ws"] } } },
  // A sandboxed preload can't require anything but `electron`, so it is one self-contained CommonJS file.
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    // The chat's markdown parser, which its first rows render with: fetched and parsed beside the entry, not after the
    // first data render asks for it (the rows would mount blank and fill in only after React's suspense reveal). And the
    // two faces the first paint sets its text in (font-display: block holds it for them), which the page would otherwise
    // find only as it lays out; a face split by script loads its Latin half up front, never its "-more" one.
    plugins: [react(), devCsp(), preloadChunks({ entries: ["src/renderer/ui/markdown/MarkdownBody.tsx"], fonts: /Geist-(Regular|SemiBold)-basic-/u })],
    // The FLEETD_RECORD encoder is a page of its own (src/main/instrument/record.ts); nothing else loads it.
    // Minified: a third of the code for the renderer to parse at launch.
    build: { minify: true, rollupOptions: { input: { index: resolve(import.meta.dirname, "src/renderer/index.html"), recorder: resolve(import.meta.dirname, "src/renderer/demo/recorder.html") } } },
  },
});
