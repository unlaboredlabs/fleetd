// The stand-in screens perf/run.ts measures (src/renderer/perf), built into out/renderer/perf so the app serves them
// from its own origin (app://fleetd/perf/; its page session refuses file://). Only `pnpm perf` builds them, after
// `pnpm build`, which empties out/renderer first, so a release build never carries them.
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "../src/renderer/perf"),
  base: "./",
  plugins: [react()],
  build: { outDir: resolve(import.meta.dirname, "../out/renderer/perf"), emptyOutDir: true },
  logLevel: "warn",
});
