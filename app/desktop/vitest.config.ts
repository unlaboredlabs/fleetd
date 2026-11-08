import { configDefaults, defineConfig } from "vitest/config";

const include = ["src/**/*.test.{ts,tsx}", "qa/**/*.test.ts", "fixtures/**/*.test.ts", "perf/**/*.test.ts"];
// A test that starts a real engine (*.engine.test.ts: Electron) runs once every other file has finished. As the slowest
// file it ran first, beside the suite's opening burst of forks (11 GB at 31 workers), and on a busy machine with no
// memory to spare Electron then took 14 to 20 s to reach app ready, where it takes under 1.
const engine = "src/**/*.engine.test.ts";

export default defineConfig({
  test: {
    environment: "node",
    projects: [
      { extends: true, test: { name: "unit", include, exclude: [...configDefaults.exclude, engine] } },
      { extends: true, test: { name: "engine", include: [engine], sequence: { groupOrder: 1 } } },
    ],
  },
});
