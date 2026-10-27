import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.{ts,tsx}", "qa/**/*.test.ts", "fixtures/**/*.test.ts", "perf/**/*.test.ts", "web/**/*.test.ts"], environment: "node" },
});
