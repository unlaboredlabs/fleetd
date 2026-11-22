import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  globalSetup: "./setup.ts",
  globalTeardown: "./report.ts",
  // Each test launches its own app; Electron windows are heavy, so not one per core. GitHub's macOS VM has 3 vCPUs:
  // three apps at once ran its load average to 20 and stalled pages for up to 10 s, past the waits' deadlines, where
  // two held it to 10 and finish a shard about as fast.
  workers: process.env.CI ? (process.platform === "darwin" ? 2 : 3) : 4,
  timeout: 120_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  projects: [
    { name: "selftest", testMatch: "selftest/*.spec.ts" },
    { name: "screens", testMatch: ["screens.spec.ts", "platform.spec.ts", "seeThrough.spec.ts"] },
    // It posts events at the screen itself, so it runs alone on it (mac.yml's swipe job).
    { name: "swipe", testMatch: "swipe.spec.ts" },
    // Not a check: the swipe's clips and frame timings, recorded on a Mac (swipeClip.spec.ts).
    { name: "swipe-clip", testMatch: "swipeClip.spec.ts" },
    { name: "site", testMatch: "site.spec.ts" },
    { name: "showcase", testMatch: "showcase.spec.ts" },
  ],
});
