// More of the grant checks, standard refusals and output limits handlers share,
// with the same words: the ones src/hub/api/grants.ts doesn't have yet.
import type { HubEvent, MachineId, ProjectRef, Role, ThreadRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { allows } from "../auth/index.ts";
import { isHuman, REPAIR_FIX } from "./grants.ts";
import type { Caller } from "./registry.ts";

/** How much one tool result may carry. */
export const LIMITS = {
  PROJECTS: 50,
  ATTENTION: 10,
  OUTCOME_THREADS: 20,
  TAIL_TEXT: 2000,
  WAKES: 200,
  OUTCOME_TASKS: 20,
  /** Threads read to fill OUTCOME_THREADS once task threads are left out. */
  OUTCOME_THREAD_SCAN: 200,
  TRAINS: 10,
} as const;

/** Events without a machine are fleet-wide and visible to every key. */
export const canRead = (caller: Caller, event: HubEvent) =>
  event.machineId === undefined || allows(caller, "read", event.machineId);

/** A grant over every machine, as global decisions need: they apply to all of them. */
export const allowsEverywhere = (caller: Caller, role: Role) =>
  caller.grants.some((grant) => grant.machines === "*" && allows({ ...caller, grants: [grant] }, role));

/** The fix for a refused write that needs admin on every machine. */
export const adminEverywhereFix = (caller: Caller) =>
  isHuman(caller) ? REPAIR_FIX : "Use an Admin key for all machines (`--machines '*'`).";

export const offline = (machineId: MachineId) =>
  new ToolError(
    "machine_offline",
    `Machine ${machineId} is offline.`,
    `Start the node on ${machineId} or check its network, then retry.`,
  );

export const unknownMachine = (machineId: MachineId) =>
  new ToolError(
    "not_found",
    `No machine ${machineId}.`,
    "Call fleetd_status to list machines.",
    undefined,
    "This hub has no machine by that id: Settings › Hub › Machines lists the ones it has, or ask the hub admin.",
  );

export const unknownProject = (r: ProjectRef) =>
  new ToolError(
    "not_found",
    `No project ${r.projectId} on ${r.machineId}.`,
    `Call project_get with machineId ${r.machineId} and no projectId.`,
    undefined,
    "It was removed, or its machine was: the projects list has the ones that are left.",
  );

export const unknownThread = (r: ThreadRef) =>
  new ToolError("not_found", `No thread ${r.threadId} on ${r.machineId}.`, "Call project_get to list the project's threads.");

/** `ToolError::new(code, message)` with an optional fix: the plain refusal. */
export const refusal = (code: ToolError["code"], message: string, fix?: string) => new ToolError(code, message, fix);

/** Refuses an agent's key for a tool that speaks for the human (hub/orders/notes.rs `require_human`). */
export function requireHuman(caller: Caller, tool: string): void {
  if (isHuman(caller)) return;
  throw new ToolError(
    "forbidden",
    `${tool} speaks for the human, and this is an agent key.`,
    "Send it from the desktop app (a human key from `fleetd pair`).",
  );
}

/** A list trimmed to its limit; `truncated` is true only when something was dropped. */
export function cap<T>(items: T[], max: number): { items: T[]; truncated?: true } {
  return items.length > max ? { items: items.slice(0, max), truncated: true } : { items };
}

/** `text` cut to at most `max` UTF-16 units, never inside a character. */
export function clip(text: string, max: number): string {
  let units = 0;
  let out = "";
  for (const c of text) {
    units += c.length;
    if (units > max) return out;
    out += c;
  }
  return text;
}
