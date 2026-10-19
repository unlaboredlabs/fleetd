// The stand-in screens perf/run.ts measures (src/renderer/perf), built into perf/out, apart from the app's out/ (which
// electron-builder packs), so nothing of it ships.
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "../src/renderer/perf"),
  base: "./",
  plugins: [react()],
  build: { outDir: resolve(import.meta.dirname, "out"), emptyOutDir: true },
  logLevel: "warn",
});
