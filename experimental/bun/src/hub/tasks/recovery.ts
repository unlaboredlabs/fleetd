// Automatic recovery (crates/fleetd/src/hub/tasks/recovery.rs): a task whose run died (its node stopped, claude was
// killed, a stall) is resumed in its own thread and worktree with a note to continue, after a delay; one that keeps
// dying for a real reason is not, and fails with a line for its lead to decide on. Pure: index.ts reads the facts and
// carries the action out.
//
// A full context is compacted in its thread, then the note follows; full again, or a thread that can't resume, and the
// task restarts fresh: a new thread on its branch and worktree, with its brief and a handoff from the last one.
import type { HubEventType, RecoveryMode, RunEnd, TaskRecovery } from "../../shared/contracts.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { oneLine } from "./render.ts";

/** Automatic recoveries per task; the death after the last one fails it. */
export const RECOVERY_MAX = 3;
/** Resumes after the node went away, which never count toward `RECOVERY_MAX`; this only stops a looping node. */
export const NODE_LOST_MAX = 20;
/** A node back from a stop gets this long to settle before a task resumes, unless it says sooner it caught up. */
const NODE_SETTLE_MS = 30_000;
const NODE_JITTER_MS = 10_000;
const MINUTE_MS = 60_000;
/** A running task's machine offline this long: its lead is told, once per offline spell. */
export const UNREACHABLE_MS = 30 * MINUTE_MS;
/** A resumed run that dies sooner did nothing, and its death counts twice. */
const PRODUCTIVE_MS = 5 * MINUTE_MS;

/** What kind of death a run's end is; the names are Rust's, as the signature spells them. */
export type Kind =
  /** The node went away under it: stopped, crashed, killed or powered off. Never the task's fault. */
  | "NodeLost"
  /** The agent's process exited or was killed with nobody asking. */
  | "Exited"
  /** The watchdog saw no output for too long. */
  | "Stalled"
  /** The machine slept, or the API connection kept failing after the node's own retries. */
  | "Unreachable"
  /** The conversation no longer fits: compacted, then restarted fresh. */
  | "ContextFull"
  /** The node would not resume its thread. */
  | "Refused"
  /** Stopped for a steer that then never ran: it goes on at once, using none of the budget. */
  | "Cut"
  /** A failure a resume doesn't fix. */
  | "Fatal"
  /** Not a death: someone stopped it, or nothing says otherwise. */
  | "NotDead";

export type Death = {
  kind: Kind;
  /** What the task's result records: the event's own cause, or `stalled`. */
  reported?: RunEnd;
  /** The cause the recovery records, for an event from a node that sends none too. */
  cause: RunEnd;
  /** In plain words, for the agent's note and the lead. */
  text: string;
  signature: string;
};

const KNOWN_ENDS: readonly string[] = [
  "unknown",
  "completed",
  "requested",
  "superseded",
  "node_stopping",
  "node_restarted",
  "machine_slept",
  "exited",
  "limited",
  "context_full",
  "failed",
  "stalled",
];

/** The run end a value names, as serde reads it: an unknown string is `unknown`, anything else none. */
function runEndOf(v: unknown): RunEnd | undefined {
  if (typeof v !== "string") return undefined;
  return KNOWN_ENDS.includes(v) ? v : "unknown";
}

type Data = Record<string, unknown> | undefined;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Reads a `thread.failed` or `thread.interrupted` event. `lastTool` is the run's last action, for the signature. */
export function death(type: HubEventType, data: Data, machine: string, lastTool: string | undefined): Death {
  const error = (data?.error ?? undefined) as Data;
  const message = str(error?.message) ?? "";
  const klass = str(error?.class) ?? "";
  const late = data?.late === true;
  const reported = runEndOf(data?.endCause);
  const stalled = str(data?.reason) === "stalled";
  const node = (how: string) => `the node on ${machine} ${how}`;
  const byClass = (): [Kind, RunEnd] =>
    klass === "process_exited" ? ["Exited", "exited"] : klass === "network" || klass === "overloaded" ? ["Unreachable", "failed"] : ["Fatal", "failed"];
  // The node's own words for its stop and its restart are the node going away whatever else the event says.
  const nodeEnd =
    reported === "node_stopping" || reported === "node_restarted"
      ? reported
      : message.trim() === "the node stopped"
        ? "node_stopping"
        : message.trim() === "node restarted mid-run"
          ? "node_restarted"
          : undefined;
  let kind: Kind;
  let cause: RunEnd;
  let text: string;
  if (stalled) {
    [kind, cause, text] = ["Stalled", "stalled", `no output for too long: ${message}`];
  } else {
    switch (nodeEnd ?? reported) {
      case "node_stopping":
        [kind, cause, text] = ["NodeLost", "node_stopping", node("stopped")];
        break;
      case "node_restarted":
        [kind, cause, text] = ["NodeLost", "node_restarted", node("restarted mid-run (a crash, a kill or a power loss)")];
        break;
      case "machine_slept":
        [kind, cause, text] = ["Unreachable", "machine_slept", `${machine} slept and the agent's stream did not come back`];
        break;
      case "exited":
        [kind, cause, text] = ["Exited", "exited", message];
        break;
      case "context_full":
        [kind, cause, text] = ["ContextFull", "context_full", "its context is full"];
        break;
      case "failed":
        [kind, cause] = byClass();
        text = message;
        break;
      // The steer's own run carries on from a superseded one; only one that never ran leaves it as the end.
      case "superseded":
        [kind, cause, text] = ["Cut", "superseded", "it was stopped for a message that then never ran"];
        break;
      case "requested":
      case "completed":
      case "limited":
      case "stalled":
        [kind, cause, text] = ["NotDead", (nodeEnd ?? reported) as RunEnd, message];
        break;
      // A node that records no cause: an interrupt reported on the node's return is the node going away.
      default:
        if (type === "thread.interrupted" && late) [kind, cause, text] = ["NodeLost", "node_stopping", node("went away")];
        else if (type === "thread.interrupted") [kind, cause, text] = ["NotDead", "requested", message];
        else {
          [kind, cause] = byClass();
          text = message;
        }
    }
  }
  const trimmed = text.trim();
  text = trimmed === "" ? (kind === "Exited" ? "the agent exited" : "it failed without saying why") : oneLine(trimmed, 200);
  const tool = lastTool !== undefined ? ` while: ${oneLine(lastTool, 120)}` : "";
  // A stall's message counts its idle minutes, which differ from one stall to the next.
  const same = stalled ? (data?.inTool === true ? "inside a tool" : "outside a tool") : text;
  return {
    kind,
    ...(stalled ? { reported: "stalled" } : reported !== undefined ? { reported } : {}),
    cause,
    signature: oneLine(`${kind}: ${same}${tool}`, 400),
    text,
  };
}

/** A resume the node refused (`message` is its words): the thread can't go on, so a new one takes over. */
export const refused = (message: string): Death => ({
  kind: "Refused",
  cause: "failed",
  text: oneLine(`its thread could not resume: ${message.trim()}`, 200),
  // However the node words it, and whichever thread it was: a fresh thread refused too is the same death.
  signature: "Refused",
});

export type Action =
  /** Queue it with the note; it goes on at `recovery.nextAt`, as `recovery.mode` says. */
  | { kind: "resume"; recovery: TaskRecovery }
  /** Fail it, with why it was not resumed, for its lead to decide. */
  | { kind: "escalate"; why: string }
  /** Fail it plainly: not a death, or nothing is left to recover for. */
  | { kind: "finish" };

const modeOf = (r: TaskRecovery): RecoveryMode => r.mode ?? "resume";

/** `prior` is the task's recovery so far. `stopped`: it must not go on. `jitter` is in [0, 1). */
export function decide(d: Death, prior: TaskRecovery | undefined, stopped: boolean, nowMs: number, jitter: number, max: number): Action {
  if (d.kind === "NotDead" || stopped) return { kind: "finish" };
  const streak = prior?.signature !== undefined && prior.signature === d.signature ? prior.streak + 1 : 1;
  // A full context is compacted first; full again since (no fresh thread in between), it starts over in a new one.
  const compacted = prior !== undefined && prior.lastCause === "context_full" && modeOf(prior) !== "fresh";
  const mode: RecoveryMode = d.kind === "ContextFull" && !compacted ? "compact" : d.kind === "ContextFull" || d.kind === "Refused" ? "fresh" : "resume";
  let delay: number;
  switch (d.kind) {
    case "NodeLost":
      delay = NODE_SETTLE_MS + Math.trunc(jitter * NODE_JITTER_MS);
      break;
    case "ContextFull":
    case "Cut":
      delay = 0;
      break;
    case "Refused":
      if (streak !== 1) return { kind: "escalate", why: `${d.text}, again in a fresh thread` };
      delay = 0;
      break;
    case "Exited":
    case "Stalled":
      if (streak !== 1) return { kind: "escalate", why: `it died the same way twice: ${d.text}` };
      delay = MINUTE_MS;
      break;
    case "Unreachable":
      if (streak === 1) delay = 15 * MINUTE_MS;
      else if (streak === 2) delay = 60 * MINUTE_MS;
      else return { kind: "escalate", why: `${d.text} (${streak} times in a row)` };
      break;
    default:
      return { kind: "escalate", why: `${d.text}, which resuming won't fix` };
  }
  const used = prior?.count ?? 0;
  const nodeLost = prior?.nodeLost ?? 0;
  // A node going away is never the task's doing: it uses none of the budget, however often or soon it happens.
  if (d.kind === "NodeLost") {
    if (nodeLost >= NODE_LOST_MAX) {
      return { kind: "escalate", why: `${d.text}, and its node has gone away ${nodeLost + 1} times under it` };
    }
    return { kind: "resume", recovery: { ...recovery(d, prior, streak, used, max, nowMs + delay, mode), nodeLost: nodeLost + 1 } };
  }
  if (d.kind === "Cut") return { kind: "resume", recovery: recovery(d, prior, streak, used, max, nowMs, mode) };
  // A full context or a refused resume says nothing about whether the run got anywhere.
  const resumedAt = prior?.resumedAt !== undefined ? parseMs(prior.resumedAt) : undefined;
  const unproductive =
    (d.kind === "Exited" || d.kind === "Stalled" || d.kind === "Unreachable") && resumedAt !== undefined && nowMs - resumedAt < PRODUCTIVE_MS;
  const count = used + (unproductive ? 2 : 1);
  if (count > max) {
    return {
      kind: "escalate",
      why: `it died again (${d.text}) after ${used} automatic recover${used === 1 ? "y" : "ies"} of at most ${max}`,
    };
  }
  // The timed ones spread ±10%, so tasks a single outage cut off don't all resume at once.
  const spread = Math.trunc(delay * (0.9 + jitter * 0.2));
  return { kind: "resume", recovery: recovery(d, prior, streak, count, max, nowMs + spread, mode) };
}

function recovery(d: Death, prior: TaskRecovery | undefined, streak: number, count: number, max: number, atMs: number, mode: RecoveryMode): TaskRecovery {
  return {
    count,
    max,
    nodeLost: prior?.nodeLost ?? 0,
    lastCause: d.cause,
    lastCauseText: oneLine(d.text, 200),
    signature: d.signature,
    streak,
    nextAt: isoMs(atMs),
    ...(prior?.resumedAt !== undefined ? { resumedAt: prior.resumedAt } : {}),
    mode,
  };
}

/** "1 of 3 recoveries used": what the budget has left. */
export const used = (r: TaskRecovery) => `${r.count} of ${r.max} recoveries used`;

/** The queued reason while it waits to go on. */
export function queuedReason(r: TaskRecovery): string {
  const t = r.nextAt?.slice(11, 19);
  const how = modeOf(r) === "resume" ? "resumes" : modeOf(r) === "compact" ? "compacts and resumes" : "restarts in a fresh thread";
  const at = t !== undefined && t.length === 8 ? `; ${how} at ${t} UTC` : "";
  return `recovering: ${r.lastCauseText}${at} (${used(r)})`;
}

/** Whether its last run ended with its node going away under it (stopped, or restarted). */
export const cutByNode = (r: TaskRecovery) => r.lastCause === "node_stopping" || r.lastCause === "node_restarted";

/**
 * When a task its node's going away cut off resumes, given that the node has been back since `liveSinceMs`; caught up
 * at `caughtUpMs` it goes on then. Undefined when its time already allows for that, or it died some other way.
 */
export function settled(r: TaskRecovery, liveSinceMs: number, caughtUpMs: number | undefined, taskId: string): string | undefined {
  if (!cutByNode(r) || r.nextAt === undefined) return undefined;
  const at = parseMs(r.nextAt);
  if (at === undefined) return undefined;
  if (caughtUpMs !== undefined) return caughtUpMs !== at ? isoMs(caughtUpMs) : undefined;
  // Each task its own share of the jitter, the same every time it is asked.
  let h = 0;
  for (const b of new TextEncoder().encode(taskId)) h = (Math.imul(h, 31) + b) >>> 0;
  const share = h % 1000;
  const due = liveSinceMs + NODE_SETTLE_MS + Math.trunc((NODE_JITTER_MS * share) / 1000);
  return due > at ? isoMs(due) : undefined;
}

/** Whether it is waiting out its delay at `nowMs`. */
export function waiting(r: TaskRecovery | undefined, nowMs: number): boolean {
  const at = r?.nextAt !== undefined ? parseMs(r.nextAt) : undefined;
  return at !== undefined && at > nowMs;
}
