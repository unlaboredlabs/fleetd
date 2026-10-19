import { rmSync } from "node:fs";
import { resultsDir } from "./harness.ts";

// A run's contact sheet shows only that run's shots.
export default function clean() {
  rmSync(resultsDir, { recursive: true, force: true });
}
