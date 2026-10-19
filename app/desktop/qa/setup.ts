import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { desktopDir, resultsDir } from "./harness.ts";

// Before any worker starts: a fresh results dir, and Electron's binary fully on disk. Electron fetches
// and unpacks it on first launch, and workers launching at once mid-unpack hit ETXTBSY.
export default function setup() {
  rmSync(resultsDir, { recursive: true, force: true });
  execFileSync(process.execPath, [path.join(desktopDir, "node_modules", "electron", "install.js")], { stdio: "inherit" });
}
