import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}", "qa/**/*.test.ts", "fixtures/**/*.test.ts", "perf/**/*.test.ts"],
    environment: "node",
    // The screens show times in the viewer's zone; pinned here so expectations hold on every machine, as QA pins it.
    env: { TZ: "UTC" },
  },
});
