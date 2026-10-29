import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The desktop modules the app imports (src/desktop.ts) find React here, as Metro does (metro.config.js).
  resolve: { alias: { react: fileURLToPath(new URL("./node_modules/react", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "plugins/**/*.test.ts"], environment: "node" },
});
