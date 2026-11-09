// `<node home>/node.json`. Holds no secrets: the enroll token is used once in
// memory and never stored. Fields this port doesn't read (the screens' sections) are kept as they are.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync, ftruncateSync } from "node:fs";
import { join } from "node:path";
import { fleetdDir } from "../shared/home.ts";

export const defaultNodeHome = () => join(fleetdDir(), "node");

export type NodeConfig = {
  hub: string;
  machineId: string;
  name: string;
  /** Directories the hub's `cmd` checks may run in (and below). Absent: the user's home directory. */
  cmdRoots?: string[];
  /** A dedicated claude config dir (`CLAUDE_CONFIG_DIR`) for this machine's sessions. */
  claudeConfigDir?: string;
  minFreeGb?: number;
  warmBuilds?: number;
  buildSlots?: number;
  screenIdleMinutes?: number;
  /** True once the hub has accepted this node's key. */
  enrolled: boolean;
  browser?: Record<string, unknown>;
  device?: Record<string, unknown>;
  ios?: Record<string, unknown>;
  desktop?: Record<string, unknown>;
  mac?: Record<string, unknown>;
  agentsMac?: boolean;
};

/** MachineId: `[a-z0-9-]{1,32}`. */
export const isMachineId = (id: string) => /^[a-z0-9-]{1,32}$/.test(id);

/** undefined when there is no config; throws when it is unreadable or does not decode. */
export function readConfig(home: string): NodeConfig | undefined {
  const file = join(home, "node.json");
  if (!existsSync(file)) return undefined;
  const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  liftScreenIdle(json);
  const ok =
    typeof json.hub === "string" &&
    typeof json.machineId === "string" &&
    typeof json.name === "string" &&
    typeof json.enrolled === "boolean";
  if (!ok) throw new Error("node.json does not decode");
  if (!isMachineId(json.machineId as string)) throw new Error("invalid machine id");
  return json as NodeConfig;
}

/** An older node.json kept the screens' idle time in each kind's section; the first one found is the one time now. */
function liftScreenIdle(json: Record<string, unknown>): void {
  if ("screenIdleMinutes" in json) return;
  for (const kind of ["browser", "device", "desktop", "ios"]) {
    const minutes = (json[kind] as Record<string, unknown> | undefined)?.idleMinutes;
    if (minutes !== undefined) {
      json.screenIdleMinutes = minutes;
      return;
    }
  }
}

export function mkdirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Pretty JSON and a newline, as serde's `to_string_pretty`; 0600 when created, an existing file keeps its mode. */
export function writeConfig(home: string, config: NodeConfig): void {
  mkdirPrivate(home);
  const fd = openSync(join(home, "node.json"), "w", 0o600);
  try {
    ftruncateSync(fd);
    writeSync(fd, `${JSON.stringify(config, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
}
