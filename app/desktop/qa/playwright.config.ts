import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  globalSetup: "./setup.ts",
  globalTeardown: "./report.ts",
  // Each test launches its own app; Electron windows are heavy, so not one per core.
  workers: process.env.CI ? 3 : 4,
  timeout: 120_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  projects: [
    { name: "selftest", testMatch: "selftest/*.spec.ts" },
    { name: "screens", testMatch: ["screens.spec.ts", "platform.spec.ts"] },
    { name: "site", testMatch: "site.spec.ts" },
  ],
});
