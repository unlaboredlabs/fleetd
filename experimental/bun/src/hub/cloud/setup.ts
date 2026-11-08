// The script a new cloud machine runs once to become a fleetd machine (crates/fleetd/src/hub/cloud/setup.rs):
// `setup.sh` from the Rust tree, rendered here for one slot. hub/pool creates the VM with it as boat's `setupScript`,
// and with the slot's pool enroll token as a 0600 file at TOKEN_FILE, under `/tmp`, which boat never snapshots.
import template from "../../../../../crates/fleetd/src/hub/cloud/setup.sh" with { type: "text" };
import { readSetup } from "../../cli/common.ts";
import { channelOf } from "../../update/index.ts";
import { machineHubUrl } from "../pool/tunnel.ts";

/** How `setup.sh` starts the one line it prints when a step fails. */
const FAILED_AT = "fleetd cloud setup failed at: ";
export const TOKEN_FILE = "/tmp/fleetd-enroll-token";
export const AGENT_USER = "fleetd";
export const MEM_PER_AGENT_GB = 4;
export const WARM_BUILDS = 1;
const GH: [string, string] = ["2.103.3", "4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d"];
const SCCACHE: [string, string] = ["0.19.0", "aa73c7270c997894038c0d8f0d297865f57569e1687883322bc431713d4bb9dd"];
const REPO = "unlaboredlabs/fleetd";

/** cli/setup/units.rs `q`: a value as the shell reads it, quoted only when it needs it. */
export function q(value: string): string {
  return value !== "" && /^[A-Za-z0-9_/.,:@%+=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export type SetupScript = { hubUrl: string; machineId: string; version: string; releaseBuild: boolean; gitIdentity?: string; claude: string };

/** `setup.sh` with the slot's values, each quoted for the shell. */
export function render(s: SetupScript): string {
  const channel = channelOf(s.version, s.releaseBuild);
  const baseUrl = channel === "stable" && s.releaseBuild ? `https://github.com/${REPO}/releases/download/v${s.version.replace(/^v+/, "")}` : "";
  const values: [string, string][] = [
    ["@HUB@", s.hubUrl],
    ["@MACHINE@", s.machineId],
    ["@CHANNEL@", channel],
    ["@BASE_URL@", baseUrl],
    ["@CLAUDE@", s.claude],
    ["@IDENTITY@", s.gitIdentity ?? ""],
    ["@TOKEN_FILE@", TOKEN_FILE],
    ["@AGENT@", AGENT_USER],
    ["@WARM_BUILDS@", String(WARM_BUILDS)],
    ["@GH_VERSION@", GH[0]],
    ["@GH_SHA256@", GH[1]],
    ["@SCCACHE_VERSION@", SCCACHE[0]],
    ["@SCCACHE_SHA256@", SCCACHE[1]],
  ];
  return values.reduce((script, [at, value]) => script.replaceAll(at, q(value)), template);
}

/** The script for one slot of this hub: the tunnel's address and the hub's build. */
export const forSlot = (machineId: string, version: string, releaseBuild: boolean, claude: string, gitIdentity?: string) =>
  render({ hubUrl: machineHubUrl(), machineId, version, releaseBuild, claude, ...(gitIdentity !== undefined ? { gitIdentity } : {}) });

/** The script for one slot of the hub at `home` (Rust `for_slot`): with the git identity its setup.json holds, as
 * `Name <email>`, so the machine's commits carry the author the owner set. Throws when setup.json can't be read. */
export function slotScript(home: string, machineId: string, version: string, releaseBuild: boolean, claude: string): string {
  const id = readSetup(home)?.gitIdentity;
  return forSlot(machineId, version, releaseBuild, claude, id === undefined ? undefined : `${id.name} <${id.email}>`);
}

/** A slot's note for boat's `setupError`: the script's failing step and its last line, else the error's last line. */
export function failure(setupError: string): string {
  const lines = setupError.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const at = lines
    .map((l) => {
      const i = l.indexOf(FAILED_AT);
      return i >= 0 ? l.slice(i + FAILED_AT.length) : undefined;
    })
    .filter((x) => x !== undefined)
    .at(-1);
  return at !== undefined ? `its setup failed at ${at}` : `its setup failed: ${lines.at(-1) ?? ""}`;
}
