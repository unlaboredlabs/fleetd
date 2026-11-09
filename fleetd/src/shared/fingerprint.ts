// A hash of the OS's id for this computer (crates/fleetd/src/fingerprint.rs `machine`): never the id itself, which
// some tools treat as private. The hub gives its own in `hub_info`; a node gives its in its hello.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

let cached: string | undefined | null = null;

/** The fingerprint of an OS machine id. */
export const fingerprintOf = (osId: string) => createHash("sha256").update(`fleetd machine ${osId.trim()}`).digest("hex");

/** `"IOPlatformUUID" = "…"` in `ioreg -rd1 -c IOPlatformExpertDevice`. */
export function platformUuid(ioreg: string): string | undefined {
  for (const line of ioreg.split("\n")) {
    const t = line.trim();
    if (!t.startsWith('"IOPlatformUUID"')) continue;
    const rest = t.slice('"IOPlatformUUID"'.length).trimStart();
    if (!rest.startsWith("=")) continue;
    return rest.slice(1).trim().replace(/^"+|"+$/g, "");
  }
  return undefined;
}

function osMachineId(): string | undefined {
  let id: string | undefined;
  if (process.platform === "darwin") {
    try {
      id = platformUuid(Bun.spawnSync(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]).stdout.toString());
    } catch {}
  } else {
    for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        id = readFileSync(file, "utf8");
        break;
      } catch {}
    }
  }
  const trimmed = id?.trim();
  return trimmed ? trimmed : undefined;
}

/** This computer's fingerprint, read once; undefined where the OS gives no id. */
export function machineFingerprint(): string | undefined {
  if (cached === null) {
    const id = osMachineId();
    cached = id === undefined ? undefined : fingerprintOf(id);
  }
  return cached;
}
