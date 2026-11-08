// Small shared pieces of the desktop area (crates/fleetd/src/node/desktop/display.rs `on_path`, `SIZE`).
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

/** The screen every session gets, in pixels. */
export const SIZE: [number, number] = [1280, 800];

/** A program on the PATH. */
export function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      if (statSync(file).isFile()) {
        accessSync(file, constants.X_OK);
        return file;
      }
    } catch {}
  }
  return undefined;
}
