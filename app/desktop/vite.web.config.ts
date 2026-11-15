// The web app's bundle (`pnpm build:web`): the desktop's renderer with the browser's shell (src/web) in place of the
// preload, as plain files for fleetd cloud to serve at its one address: out/web/index.html and out/web/assets/. Nothing
// of Electron's; nothing loaded from anywhere but the page's own origin. The desktop's own build is electron.vite.config.ts.
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "src/web"),
  // From the origin's root: the cloud answers index.html on any path, so a relative asset path would break on a deep one.
  base: "/",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "out/web"),
    emptyOutDir: true,
    minify: true,
    // Firefox, Safari and Chrome of the last two years: top-level await and the rest the renderer is written in.
    target: ["chrome120", "firefox121", "safari17"],
    // libsodium's WebAssembly is inlined in its own chunk, loaded on the first secret only.
    chunkSizeWarningLimit: 4096,
  },
});
