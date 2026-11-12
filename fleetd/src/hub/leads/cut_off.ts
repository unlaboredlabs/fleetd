// A lead whose turn was cut off carries on by itself. Its node stopping or
// restarting under it wakes it every time; its own turn ending badly (the stall guard, its claude exiting unasked, its
// machine sleeping) wakes it once per run of such turns, so a turn that keeps hanging doesn't loop. The wake goes
// through the offline write queue like any other.
import type { HubEvent, HubEventType, ProjectRef } from "../../shared/contracts.ts";
import { oneLine } from "./text.ts";
import type { StoredLead } from "./stored.ts";

/** How a run died (tasks/recovery.rs `Kind`), the kinds the lead's wake reads. */
export type DeathKind = "node_lost" | "stalled" | "exited" | "unreachable" | "context_full" | "cut" | "not_dead" | "fatal";

/** Reads a `thread.failed` or `thread.interrupted` event (tasks/recovery.rs `death`): its kind and its words. */
export function death(type: HubEventType, data: Record<string, unknown> | undefined, machine: string): { kind: DeathKind; text: string } {
  const field = (...path: string[]) => {
    let v: unknown = data;
    for (const k of path) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
    return typeof v === "string" ? v : undefined;
  };
  const message = field("error", "message") ?? "";
  const cls = field("error", "class") ?? "";
  const late = data?.late === true;
  const reported = typeof data?.endCause === "string" ? (data.endCause as string) : undefined;
  const stalled = field("reason") === "stalled";
  const node = (how: string) => `the node on ${machine} ${how}`;
  const byClass = (): DeathKind => (cls === "process_exited" ? "exited" : cls === "network" || cls === "overloaded" ? "unreachable" : "fatal");
  const nodeEnd =
    reported === "node_stopping" || reported === "node_restarted"
      ? reported
      : message.trim() === "the node stopped"
        ? "node_stopping"
        : message.trim() === "node restarted mid-run"
          ? "node_restarted"
          : undefined;
  let kind: DeathKind;
  let text: string;
  if (stalled) [kind, text] = ["stalled", `no output for too long: ${message}`];
  else {
    switch (nodeEnd ?? reported) {
      case "node_stopping":
        [kind, text] = ["node_lost", node("stopped")];
        break;
      case "node_restarted":
        [kind, text] = ["node_lost", node("restarted mid-run (a crash, a kill or a power loss)")];
        break;
      case "machine_slept":
        [kind, text] = ["unreachable", `${machine} slept and the agent's stream did not come back`];
        break;
      case "exited":
        [kind, text] = ["exited", message];
        break;
      case "context_full":
        [kind, text] = ["context_full", "its context is full"];
        break;
      case "failed":
        [kind, text] = [byClass(), message];
        break;
      case "superseded":
        [kind, text] = ["cut", "it was stopped for a message that then never ran"];
        break;
      case "requested":
      case "completed":
      case "limited":
      case "stalled":
        [kind, text] = ["not_dead", message];
        break;
      default:
        // A node that records no cause: an interrupt reported on the node's return is the node going away.
        if (type === "thread.interrupted" && late) [kind, text] = ["node_lost", node("went away")];
        else if (type === "thread.interrupted") [kind, text] = ["not_dead", message];
        else [kind, text] = [byClass(), message];
    }
  }
  const t = text.trim();
  return { kind, text: t === "" ? (kind === "exited" ? "the agent exited" : "it failed without saying why") : oneLine(t, 200) };
}

/** How a lead's thread ended, as its wakes see it. */
export type End = { kind: "node_lost"; text: string } | { kind: "own"; text: string } | { kind: "completed" };

/** The project and how its lead's thread ended; undefined for another thread, or an end that wakes nothing. */
export function end(event: HubEvent, leads: StoredLead[]): { project: ProjectRef; end: End } | undefined {
  if (event.type !== "thread.failed" && event.type !== "thread.interrupted" && event.type !== "thread.completed") return undefined;
  const machine = event.machineId;
  const data = event.data as Record<string, unknown> | undefined;
  const thread = event.threadId ?? (typeof data?.threadId === "string" ? data.threadId : undefined);
  if (machine === undefined || thread === undefined) return undefined;
  const lead = leads.find((l) => l.projectRef.machineId === machine && l.threadId === thread);
  if (!lead) return undefined;
  if (event.type === "thread.completed") return { project: lead.projectRef, end: { kind: "completed" } };
  const died = death(event.type, data, machine);
  if (died.kind === "node_lost") {
    return {
      project: lead.projectRef,
      end: {
        kind: "node_lost",
        text: `- Your last turn was cut off: ${died.text}, and it is back. Carry on from where you were; a step you were taking may be half done, so check it before you repeat it.`,
      },
    };
  }
  if (died.kind === "stalled" || died.kind === "exited" || died.kind === "unreachable") {
    return {
      project: lead.projectRef,
      end: {
        kind: "own",
        text: `- Your last turn was cut off: ${died.text}. Carry on from where you were; a step you were taking may be half done, so check it before you repeat it, and don't retry a step that hung the same way.`,
      },
    };
  }
  return undefined;
}
