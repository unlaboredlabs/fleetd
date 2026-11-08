// Helpers my modules share that other areas own in Rust (orders/notes `require_human`, api/grants `unknown_*`, navi/owner
// `others`, hub/queue's ports) until those areas port them, plus the landed seams re-exported: the lead-call registry
// (src/hub/lead_calls) and the lead wakes (src/hub/api/leads.ts).
import { ToolError } from "../../shared/errors.ts";
import type { ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { isHuman } from "../api/grants.ts";
import type { Caller } from "../api/registry.ts";

export type { CallerAgent, LeadCall, LeadCaller, LeadCallHandler } from "../lead_calls/index.ts";
export { leadCalls } from "../lead_calls/index.ts";
export { leadWakes, type LineKind, type Trigger } from "../api/leads.ts";

export function requireHuman(caller: Caller, tool: string): void {
  if (isHuman(caller)) return;
  throw new ToolError(
    "forbidden",
    `${tool} speaks for the human, and this is an agent key.`,
    "Send it from the desktop app (a human key from `fleetd pair`).",
  );
}

export const unknownProject = (r: ProjectRef) =>
  new ToolError(
    "not_found",
    `No project ${r.projectId} on ${r.machineId}.`,
    `Call project_get with machineId ${r.machineId} and no projectId.`,
    undefined,
    "It was removed, or its machine was: the projects list has the ones that are left.",
  );

export const unknownMachine = (machineId: string) =>
  new ToolError(
    "not_found",
    `No machine ${machineId}.`,
    "Call fleetd_status to list machines.",
    undefined,
    "This hub has no machine by that id: Settings › Hub › Machines lists the ones it has, or ask the hub admin.",
  );

export const unknownThread = (r: { machineId: string; threadId: string }) =>
  new ToolError("not_found", `No thread ${r.threadId} on ${r.machineId}.`, "Call project_get to list the project's threads.");

/** At most `max` items, and whether more were left out (api/grants.rs `cap`). */
export function cap<T>(items: T[], max: number): { items: T[]; truncated?: true } {
  return items.length > max ? { items: items.slice(0, max), truncated: true } : { items };
}

/** A message sent through the hub's offline write queue (hub/queue): delivered now, or queued for its machine. */
export type QueueSent = { queued: boolean; queuedUntil?: string; runId?: string };

/** What the write queue and usage layer give the areas that send turns (hub/queue/ports.rs), until they're ported. */
export type QueuePorts = {
  send(thread: { machineId: string; threadId: string }, message: string, clientRequestId: string, wakeId?: string): Promise<QueueSent>;
  isConnected(machineId: string): boolean;
  /** Why the usage layer holds the thread's turns now (a paused login, a parked thread); undefined when it doesn't. */
  usageHold(thread: { machineId: string; threadId: string }): Promise<string | undefined> | string | undefined;
  whenClear(thread: { machineId: string; threadId: string }): Promise<void>;
};

/** `queuePorts(hub)`: the write queue's owner sets these; until then a send fails as undelivered. */
export const queuePorts = (hub: Hub) =>
  hub.area<QueuePorts>("queue_ports", () => ({
    send: async () => {
      throw new ToolError("machine_offline", "The hub's write queue is not ported to Bun yet.");
    },
    isConnected: () => false,
    usageHold: () => undefined,
    whenClear: () => new Promise<void>(() => {}),
  }));
