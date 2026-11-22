// The web app's bundle (`pnpm build:web`): the desktop's renderer with the browser's shell (src/web) in place of the
// preload, as plain files for fleetd cloud to serve at its one address: out/web/index.html and out/web/assets/. Nothing
// of Electron's; nothing loaded from anywhere but the page's own origin. The desktop's own build is electron.vite.config.ts.
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { preloadChunks } from "./scripts/preloadChunks.ts";

/**
 * What the first chat draws beyond the entry, a chunk loaded by import(): the app (once the session is read). index.html
 * names it, and the fonts' Latin halves (scripts/preloadChunks.ts), so the
 * browser fetches them in one wave alongside the entry and the session read, not a wave per import. The side panel's
 * code is asked for once the chat has shown (shell/panel.tsx), into a slot already at its width; the markdown parser
 * (the messages show their plain words until it comes: ui/markdown), Settings, Shiki and the rest load then too
 * (ui/lib/idle.ts).
 */
const FIRST_CHAT = ["src/renderer/src/main.tsx"];

export default defineConfig({
  root: resolve(import.meta.dirname, "src/web"),
  // From the origin's root: the cloud answers index.html on any path, so a relative asset path would break on a deep one.
  base: "/",
  plugins: [react(), preloadChunks({ entries: FIRST_CHAT, fonts: /Geist-(Regular|Medium|SemiBold)-basic-/u })],
  build: {
    outDir: resolve(import.meta.dirname, "out/web"),
    emptyOutDir: true,
    minify: true,
    // Firefox, Safari and Chrome of the last two years: top-level await and the rest the renderer is written in.
    target: ["chrome120", "firefox121", "safari17"],
    // libsodium's WebAssembly is inlined in its own chunk, loaded on the first secret only.
    chunkSizeWarningLimit: 4096,
    // The icons in one chunk: each icon that a lazy screen shares with the first chat is otherwise a file of its own
    // (~200 bytes) in the first load, a request each.
    rolldownOptions: { output: { advancedChunks: { groups: [{ name: "icons", test: /lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/]/u }] } } },
  },
});
