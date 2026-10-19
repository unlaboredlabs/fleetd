import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts", "fixtures/**/*.test.ts"], environment: "node" },
});
