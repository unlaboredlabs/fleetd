// What the doctor reads from `<hub home>/setup.json`, which `fleetd init` and `fleetd machine add` write: the hub's
// address, the commit identity, and how each machine was set up. Only the
// fields the doctor needs; the file may be absent (a lab or hand-joined fleet).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Platform = "linux" | "darwin";

export type MachineSetup = {
  sshHost: string;
  /** Set up on the hub's own machine (`machine add --local`), without SSH. */
  local: boolean;
  platform: Platform;
  uid: number;
};

export type HubSetup = {
  /** Where devices and nodes reach the hub. */
  url?: string;
  gitIdentity?: { name: string; email: string };
  machines: Record<string, MachineSetup>;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** serde's rules for the fields read: a wrong type fails the whole file, as serde_json does. */
function decode(v: unknown): HubSetup {
  if (!isObject(v)) throw new Error("invalid type: expected struct HubConfig");
  const out: HubSetup = { machines: {} };
  if (v.url !== undefined && v.url !== null) {
    if (typeof v.url !== "string") throw new Error("invalid type for `url`: expected a string");
    out.url = v.url;
  }
  if (v.gitIdentity !== undefined && v.gitIdentity !== null) {
    const g = v.gitIdentity;
    if (!isObject(g) || typeof g.name !== "string" || typeof g.email !== "string") {
      throw new Error("invalid `gitIdentity`: expected { name, email }");
    }
    out.gitIdentity = { name: g.name, email: g.email };
  }
  if (v.machines !== undefined) {
    if (!isObject(v.machines)) throw new Error("invalid type for `machines`: expected a map");
    for (const [id, m] of Object.entries(v.machines)) {
      if (!isObject(m) || typeof m.sshHost !== "string" || typeof m.uid !== "number" || !Number.isInteger(m.uid) || m.uid < 0) {
        throw new Error(`invalid machine ${id}: expected sshHost, platform and uid`);
      }
      if (m.platform !== "linux" && m.platform !== "darwin") {
        throw new Error(`unknown variant \`${String(m.platform)}\`, expected \`linux\` or \`darwin\``);
      }
      if (m.local !== undefined && typeof m.local !== "boolean") throw new Error(`invalid machine ${id}: local`);
      out.machines[id] = { sshHost: m.sshHost, local: m.local === true, platform: m.platform, uid: m.uid };
    }
  }
  return out;
}

/** The setup record, or why it could not be read; an absent file is an empty one. */
export function readHubSetup(home: string): [HubSetup, string | undefined] {
  const file = join(home, "setup.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [{ machines: {} }, undefined];
  }
  try {
    return [decode(JSON.parse(text)), undefined];
  } catch (error) {
    const first = ((error as Error).message ?? "").split("\n")[0] ?? "";
    return [{ machines: {} }, `${file} is not valid: ${first}`];
  }
}

/** The command that sets this machine up again, as `fleetd machine add` was run for it. */
export function addCommand(m: MachineSetup): string {
  // A record from before the `local` flag has the hub's own machine as "localhost".
  return m.local || m.sshHost === "localhost" ? "fleetd machine add --local" : `fleetd machine add ${m.sshHost}`;
}

/** The command that restarts a fleetd service, named as the CLI's setup names its units. */
export function restartCommand(role: string, setup: MachineSetup | undefined): string {
  return setup?.platform === "darwin"
    ? `launchctl kickstart -k gui/${setup.uid}/sh.fleetd.${role}`
    : `systemctl --user restart fleetd-${role}.service`;
}
