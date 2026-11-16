// `revyl` on every agent session's PATH (node/revyl `start`): it runs this node's binary as `fleetd revyl`, which
// sends the command to the node to run on the session's own Revyl screen with the team's key. The real `revyl` stays
// the node's: an agent never gets the key.
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../secrets/files.ts";

/** The folder on every agent session's PATH that holds `revyl`. */
export const binDir = (home: string) => join(home, "revyl", "bin");

const quoted = (argv: string[]) => argv.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ");

/** `revyl`: `self` (this node's command line) as `fleetd revyl`. */
export const shim = (self: string[]) =>
  `#!/bin/sh\n# fleetd's: Revyl's CLI on your own Revyl screen, with the team's key held back (fleetd revyl).\nexec ${quoted(self)} revyl "$@"\n`;

/** Writes `revyl` at the node's start, for the binary running now. */
export function installShim(home: string, self: string[]): void {
  const dir = binDir(home);
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "revyl");
  writeAtomic(bin, shim(self));
  chmodSync(bin, 0o755);
}
