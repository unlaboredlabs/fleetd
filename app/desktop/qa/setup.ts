import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { desktopDir, launch, resultsDir } from "./harness.ts";

// Before any worker starts: a fresh results dir, and Electron's binary fully on disk. Electron fetches
// and unpacks it on first launch, and workers launching at once mid-unpack hit ETXTBSY.
//
// On macOS, the app's first launch on a fresh VM also pays what the system does once per binary (its first-run checks,
// reading the framework from disk, compiling the GPU's shaders): its page then stalls 6-11 s, which a test's waits
// can't tell from a screen that never loads (a shard's first three tests failed or took 30 s). One launch here pays it
// before any test starts; the next ones take 1-2 s.
export default async function setup() {
  rmSync(resultsDir, { recursive: true, force: true });
  execFileSync(process.execPath, [path.join(desktopDir, "node_modules", "electron", "install.js")], { stdio: "inherit" });
  if (process.platform === "darwin") {
    const { settled, close } = await launch("typical");
    try {
      await settled();
    } finally {
      await close();
    }
  }
}
