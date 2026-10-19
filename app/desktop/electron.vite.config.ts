import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

const CSP_DEV =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'";

// The dev server needs the React Refresh inline preamble and the HMR socket; the built app keeps index.html's CSP.
const devCsp = (): Plugin => ({
  name: "fleetd-dev-csp",
  apply: "serve",
  transformIndexHtml: (html) => html.replace(/(http-equiv="Content-Security-Policy"\s+content=")[^"]*"/u, `$1${CSP_DEV}"`),
});

export default defineConfig({
  main: {},
  // A sandboxed preload can't require anything but `electron`, so it is one self-contained CommonJS file.
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    plugins: [react(), devCsp()],
  },
});
