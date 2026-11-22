// A lead whose turn was cut off carries on by itself. Its node stopping or
// restarting under it wakes it every time; its own turn ending badly (the stall guard, its claude exiting unasked, its
// machine sleeping) wakes it once per run of such turns, so a turn that keeps hanging doesn't loop. The wake goes
// through the offline write queue like any other. A run whose hosted sandbox didn't come up never reached claude: the
// person reads why in the chat, and the lead is started again by itself once its provider is offered again, its message
// (which the node keeps) first (`not_started`, ./start_retry.ts). A turn Claude refused for its sign-in (an expired or
// revoked token, a bad key) wakes nothing, which would be refused the same way: the person reads where to reconnect it,
// and the lead carries on once they do (`signed_out`, ./signed_in.ts).
import type { ClaudeAccount, HubEvent, HubEventType, ProjectRef } from "../../shared/contracts.ts";
import { ASIDE_MS, RATE_MS, RATE_WORDS } from "../../shared/sandbox.ts";
import { oneLine } from "./text.ts";
import type { StoredLead } from "./stored.ts";

/** How a run died (tasks/recovery.rs `Kind`), the kinds the lead's wake reads. */
export type DeathKind = "node_lost" | "stalled" | "exited" | "unreachable" | "no_sandbox" | "signed_out" | "context_full" | "cut" | "not_dead" | "fatal";

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
  const byClass = (): DeathKind =>
    cls === "process_exited" ? "exited" : cls === "network" || cls === "overloaded" ? "unreachable" : cls === "sandbox" ? "no_sandbox" : cls === "auth" ? "signed_out" : "fatal";
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

/** How a lead's thread ended, as its wakes see it. `not_started`: its claude never started; `message` is the node's
 * words for why (`notStartedLine` makes the chat's line of them), once per run (`runId`). `signed_out`: Claude refused
 * its sign-in (`signedOutLine`), once per run. */
export type End =
  | { kind: "node_lost"; text: string }
  | { kind: "own"; text: string }
  | { kind: "not_started"; message: string; runId?: string }
  | { kind: "signed_out"; runId?: string }
  | { kind: "completed" };

/** The chat's line when Claude refused the lead's sign-in, by what the lead runs on (the thread's account; none: the
 * machine's own login): where it is reconnected, and that the lead then carries on by itself. */
export function signedOutLine(account: ClaudeAccount | undefined): string {
  if (account?.kind === "hub") return "The hub's Claude API key stopped working for this bot: an admin replaces it in Settings › Hub › Setup › Claude. The lead carries on by itself once it is.";
  if (account) return "Your Claude sign-in for this bot stopped working: reconnect it in Settings › Accounts › Claude. The lead carries on by itself once it is.";
  return "Claude's sign-in on this bot's machine stopped working: sign it in again there with `claude auth login`, then send a message.";
}

/** The wake's line for a lead whose sign-in was reconnected: its last turn was refused before it began. */
export const SIGNED_IN_LINE =
  "- Your Claude sign-in was reconnected. Your last turn was refused for it before you could answer, so the message above has no answer yet: answer it, and carry on from where you were.";

/** How many times in a row a lead whose start didn't come up is started again by itself. */
export const START_RETRIES = 3;
/** A little past the provider's set-aside, so the start again finds it offered. */
const RETRY_MARGIN_MS = 30_000;

/** The minutes after its `n`-th start in a row that didn't come up until the lead is started again: the provider's
 * set-aside, doubled each time (10, 20, 40); one each time when the node's words (`message`) say the provider's start
 * rate refused it (shared/sandbox.ts RATE_WORDS), which frees by itself in a minute; none after START_RETRIES. */
const retryMinutes = (n: number, message = ""): number | undefined =>
  n >= 1 && n <= START_RETRIES ? (message.includes(RATE_WORDS) ? RATE_MS / 60_000 : (ASIDE_MS / 60_000) * 2 ** (n - 1)) : undefined;

/** The wait in milliseconds after the `n`-th start in a row that didn't come up, a little past `retryMinutes`. */
export function retryWaitMs(n: number, message?: string): number | undefined {
  const m = retryMinutes(n, message);
  return m === undefined ? undefined : m * 60_000 + RETRY_MARGIN_MS;
}

/** The chat's line when the lead's `n`-th start in a row didn't come up (the node's words: "… no hosted sandbox came
 * up at boat.dev: …"): why, and that it is tried again by itself with the person's message kept, or, past
 * START_RETRIES, that their next message tries again. In the person's words: the provider's own error stays in the
 * run's failure, and the node's "try again" and its clock time (UTC, the node's) go, since this line says when. A box
 * that came up but couldn't start the lead (Claude out of its reach) has the node's own sentence, which says what to do,
 * without the node's wrapper (its claude's path, its cwd). */
export function notStartedLine(message: string, n: number): string {
  const minutes = retryMinutes(n, message);
  const again =
    minutes === undefined
      ? `It was tried again ${START_RETRIES} times by itself; your message is kept, and the lead tries again when you send another.`
      : `It tries again by itself in about ${minutes === 1 ? "a minute" : `${minutes} minutes`}, and your message is kept for it.`;
  const at = /no hosted sandbox came up at ([^\s:]+)/.exec(message)?.[1];
  if (at) return `The lead couldn't start: no sandbox came up for it at ${at}. ${again} If it keeps failing, check ${at} in Settings › Hub › Machines.`;
  const own = (/^could not start \S+: ([\s\S]*?)(?: \(cwd [^)]*\))?$/.exec(message.trim())?.[1] ?? message)
    // A path the node names (its settings file's) is for the log, not the person.
    .replace(/\s*\([^()]*\/[^()]*\)/g, "")
    // The provider's set-aside as the node words it (shared/sandbox.ts troubleLine): this line says when instead.
    .replace(/;\s*trying again at \d{1,2}:\d{2}/g, "")
    .replace(/\s*\(try again in a minute\)/g, "")
    .trim()
    .replace(/[.\s]+$/, "");
  return `The lead couldn't start${own ? `: ${own}` : ""}. ${again}`;
}

/** The wake's line for a lead started again by itself: the message ahead of it (the node's kept one) never reached it. */
export const RETRY_LINE =
  "- Your last start didn't come up (no sandbox), so the message above never reached you until now: fleetd started you again by itself. Answer it.";

/** The lead's starts in a row that didn't come up, from its project's `thread.failed` and `thread.completed` events
 * newest first: how many runs (`n`), and the newest one's event (`seq`, `at`); they end at its thread's last other end
 * (a completed turn, another failure). Undefined when its thread's newest end is another. The start again is due
 * `retryWaitMs(n, message)` after `at`, `message` being the newest one's words. */
export function failedRun(newestFirst: Iterable<HubEvent>, lead: StoredLead): { n: number; seq: number; at: string; message: string } | undefined {
  const runs = new Set<string>();
  let newest: HubEvent | undefined;
  let message = "";
  for (const e of newestFirst) {
    const found = end(e, [lead]);
    if (!found) {
      // Its thread's end that wakes nothing (a stop asked for): the run of failed starts is over there.
      if ((e.threadId ?? (e.data as { threadId?: unknown } | undefined)?.threadId) === lead.threadId) break;
      continue;
    }
    if (found.end.kind !== "not_started") break;
    if (!newest) [newest, message] = [e, found.end.message];
    runs.add(found.end.runId ?? `seq:${e.seq}`);
  }
  return newest ? { n: runs.size, seq: newest.seq, at: newest.at, message } : undefined;
}

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
  if (died.kind === "no_sandbox") {
    const runId = typeof data?.runId === "string" ? data.runId : undefined;
    const message = (data?.error as { message?: unknown } | undefined)?.message;
    return { project: lead.projectRef, end: { kind: "not_started", message: typeof message === "string" ? message : "", ...(runId ? { runId } : {}) } };
  }
  if (died.kind === "signed_out") {
    const runId = typeof data?.runId === "string" ? data.runId : undefined;
    return { project: lead.projectRef, end: { kind: "signed_out", ...(runId ? { runId } : {}) } };
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
