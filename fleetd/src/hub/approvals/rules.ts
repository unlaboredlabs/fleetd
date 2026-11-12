// What a person's approvals and secret requests hold to, without the hub (index.ts runs them): their waits and words,
// the gated_run and request_secret calls, and what a command fleetd can store is.
import type { SecretEnvEntry } from "../../shared/contracts.ts";

export const EVIDENCE_MAX = 2000;
/** Who answered a request approved as it opened, with no ask (`createApproved`). */
export const NO_ASK = "fleetd:no-ask";
/** Evidence while an approved command runs; replaced by its result. */
export const RUNNING = "running on";
export const NOT_RUN_AFTER_RESTART = "not run: the hub restarted before it ran; approve it again to run it";
export const HUMAN_ONLY_SECRET_FIX =
  "Enter it from the fleetd desktop app or another client with a --human key; agent keys never handle secret values.";
/** How long the hub waits for a node to link again, to ask it for the result of an approved command it lost. */
export const RELINK_WAIT_MS = 15 * 60_000;
/** How often it looks whether the node is back meanwhile. */
export const RELINK_POLL_MS = 1000;
/** How long an approval given while its node is offline waits for it to link again before it goes back to the person:
 * a node restarting for an update is back well within it. */
export const OFFLINE_WAIT_MS = 30_000;
export const GATED_DEFAULT_TIMEOUT_SEC = 1800;

/** Why an approved command whose result neither the hub nor its node has goes back to the person. */
export const mayHaveRun = (why: string, machineId: string) =>
  `interrupted, may have run: ${why}; check on ${machineId} whether it ran before you approve it again`;

/** `gated_run`'s call (lead-calls `GatedRunCall` without `op`). */
export type GatedRunInput = {
  argv: string[];
  cwd?: string;
  class: string;
  reason: string;
  secretEnv?: SecretEnvEntry[];
  timeoutSec: number;
  workstreamId?: string;
};

/** lead-calls `RequestSecretCall`. */
export type RequestSecretCall = { key: string; sink: string; text: string; envName?: string; workstreamId?: string };

export const GATED_CLASSES = ["irreversible", "money", "credential"];

/** The node runs at most 4 hours. */
export const GATED_MAX_TIMEOUT_SEC = 14_400;

/** What the contracts' `GatedRunSpec` refuses; undefined for a command fleetd can store. */
export function gatedRefusal(call: GatedRunInput, cwd: string): string | undefined {
  if (!Array.isArray(call.argv) || call.argv.length < 1 || call.argv.length > 64) return "argv holds 1 to 64 words";
  if (call.argv.some((w) => typeof w !== "string")) return "each word of argv is a string";
  if (!cwd.startsWith("/") || cwd.length > 1000) return "cwd must be an absolute path of at most 1000 characters";
  if (!GATED_CLASSES.includes(call.class)) return `class must be one of ${GATED_CLASSES.join(", ")}`;
  const reason = typeof call.reason === "string" ? [...call.reason].length : 0;
  if (reason < 1 || reason > 500) return "reason must be 1 to 500 characters";
  if (!Number.isInteger(call.timeoutSec) || call.timeoutSec < 1 || call.timeoutSec > GATED_MAX_TIMEOUT_SEC) {
    return `timeoutSec is 1 to ${GATED_MAX_TIMEOUT_SEC}`;
  }
  const env = call.secretEnv ?? [];
  if (!Array.isArray(env) || env.length > 20) return "secretEnv holds at most 20 entries";
  if (env.some((e, i) => env.slice(0, i).some((x) => x.name === e.name))) return "secretEnv names each variable once";
  return undefined;
}
