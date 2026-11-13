// The lines a lead's wake carries, one per event: every area that wakes a lead
// renders its line here, so the words stay in one place.
import { oneLine } from "./text.ts";

export type Ended = "done" | "failed" | "not_resumed" | "cancelled";

/** The digest's agents line: `agents: 2 running of 4 (project), 0 queued, 2 free`. */
export type AgentsLine = {
  running: number;
  cap: number;
  queued: number;
  source: string;
  idleSinceMs: number;
  idleMinutes: number;
};

export const agentsFree = (a: AgentsLine) => (a.queued > 0 ? 0 : Math.max(a.cap - a.running, 0));

export const agentsLineText = (a: AgentsLine) =>
  `agents: ${a.running} running of ${a.cap} (${a.source}), ${a.queued} queued, ${agentsFree(a)} free`;

export type Event =
  | { kind: "order"; workstream: string; text: string }
  | { kind: "order_stopped"; workstream: string; title: string; why: string; cancelled: number }
  | { kind: "agent_ended"; task: string; ended: Ended; title: string; place: string; result: string }
  | {
      kind: "agent_recovered";
      task: string;
      title: string;
      place: string;
      attempt: number;
      used: string;
      cause: string;
      doing: string;
      worktree: string;
    }
  | { kind: "agent_unreachable"; task: string; title: string; place: string; machine: string; minutes: number }
  | { kind: "message_not_sent"; task: string; title: string; why: string; text: string }
  | { kind: "agent_waiting"; task: string; title: string; question: string }
  | { kind: "agent_pr"; task: string; prUrl: string }
  | { kind: "agent_pr_skipped"; task: string; why: string }
  | { kind: "agent_steered"; task: string; steerKind: string; steer: string; text: string }
  /** One agent wrote to others (`agent_message`): a quiet copy for the lead. `to` names each recipient, with how it
   * stands when not delivered: "T4, T7 (not woken)". */
  | { kind: "agent_messaged"; from: string; to: string; message: string; text: string }
  | { kind: "pr_merged"; change: string; prUrl: string; sha: string; by?: string }
  | { kind: "pr_left"; change: string; prUrl: string; why: string }
  | { kind: "pr_gave_up"; change: string; prUrl: string; why: string; tries: number }
  | { kind: "pr_review_not_recorded"; change: string; prUrl: string; task: string; next: string; tail: string }
  | { kind: "pr_review_stalled"; change: string; prUrl: string; task: string; tries: number; tail: string }
  | { kind: "pr_refused"; prUrl: string; task: string; message: string; fix?: string }
  | { kind: "pr_note"; change: string; prUrl: string; text: string }
  | { kind: "request"; request: string; what: string; outcome: string; tail?: string }
  | { kind: "cap_raised"; maxAgents: number; free: number }
  | { kind: "decision_overturned"; decision: string; key: string; was: string; replacedBy?: [string, string]; why: string }
  | { kind: "checklist_removed"; items: [number, string][] }
  /** A person moved a chat message to another order (`chat_about_set`): their correction of its tag. */
  | { kind: "retagged"; who: string; message: string; from: string; to: string; text: string };

const quote = (text: string) => `"${oneLine(text, 300)}"`;

/** `PR #12` for a GitHub PR URL, else `PR <url>`. */
export function prLabel(url: string): string {
  const at = url.lastIndexOf("/pull/");
  const n = at < 0 ? "" : url.slice(at + 6);
  return /^[0-9]+$/.test(n) ? `PR #${n}` : `PR ${url}`;
}

/** A quoted body under an event line, `  > …` per line. */
export function body(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return ["  > (no final message)"];
  return trimmed.split("\n").map((l) => `  > ${l}`.trimEnd());
}

const ENDED: Record<Ended, string> = {
  done: "finished",
  failed: "failed",
  not_resumed: "failed and was not resumed",
  cancelled: "was cancelled",
};

const stays = (machine: string) =>
  `  > Its worktree and session are on ${machine}, so it stays there. To have it done elsewhere, cancel it and start a new task.`;

export function renderEvent(e: Event): string {
  const [head, rest]: [string, string[]] = (() => {
    switch (e.kind) {
      case "order":
        return [`- new order ${e.workstream}: ${quote(e.text)}`, []];
      case "order_stopped":
        return [
          `- ${e.workstream} stopped by the human (${e.why}): ${oneLine(e.title, 80)}; ${e.cancelled} agents cancelled, merged PRs stay; do no more work on it`,
          [],
        ];
      case "agent_ended":
        return [`- ${e.task} ${ENDED[e.ended]}: ${oneLine(e.title, 80)}${e.place}`, body(e.result)];
      case "agent_recovered":
        return [
          `- ${e.task} resumed automatically (attempt ${e.attempt}, ${e.used}): ${oneLine(e.title, 80)}${e.place}`,
          [`  > its run was cut off (${oneLine(e.cause, 200)}) during: ${oneLine(e.doing, 200)}. ${e.worktree}`],
        ];
      case "agent_unreachable":
        return [
          `- ${e.task} waits for ${e.machine}, offline for ${e.minutes} min: ${oneLine(e.title, 80)}${e.place}; it resumes on its own when ${e.machine} is back`,
          [stays(e.machine)],
        ];
      case "message_not_sent":
        return [
          `- ${e.task} did not get your message (${e.why}): ${oneLine(e.title, 80)}; it runs again, so send it again with message_agent if it still applies`,
          body(e.text),
        ];
      case "agent_waiting":
        return [`- ${e.task} waiting for an answer: ${oneLine(e.title, 80)}`, body(e.question)];
      case "agent_pr":
        return [`- ${e.task}'s PR: ${e.prUrl}`, []];
      case "agent_pr_skipped":
        return [`- ${e.task}: PR lookup skipped: ${oneLine(e.why, 200)}`, []];
      case "agent_steered":
        return [`- the human steered ${e.task} (${e.steerKind}) directly (${e.steer}): ${quote(e.text)}`, []];
      case "agent_messaged":
        return [`- ${e.from} → ${e.to} (${e.message}): ${quote(e.text)}`, []];
      case "pr_merged":
        return [`- ${prLabel(e.prUrl)} merged${e.sha}: ${e.prUrl} (${e.change}${e.by === undefined ? "" : `, by ${e.by}`})`, []];
      case "pr_left":
        return [`- ${prLabel(e.prUrl)} left the train: ${e.why} (${e.change}, ${e.prUrl})`, []];
      case "pr_gave_up":
        return [
          `- ${prLabel(e.prUrl)} not merged: ${e.why}; the train gave up after ${e.tries} tries (${e.change}, ${e.prUrl})`,
          [],
        ];
      case "pr_review_not_recorded":
        return [
          `- ${prLabel(e.prUrl)} verdict not recorded: the reviewer ${e.task} ended without one, so it counts as no approval; ${e.next} reviews it once more (${e.change}, ${e.prUrl})`,
          body(e.tail),
        ];
      case "pr_review_stalled":
        return [
          `- ${prLabel(e.prUrl)} not reviewed, verdict not recorded: ${e.tries} reviewers in a row ended without one, the last ${e.task}; the train starts no more (${e.change}, ${e.prUrl})`,
          body(e.tail),
        ];
      case "pr_refused":
        return [
          `- ${prLabel(e.prUrl)} from ${e.task} refused by the train: ${e.message}${e.fix === undefined ? "" : ` Fix: ${e.fix}.`} (${e.prUrl})`,
          [],
        ];
      case "pr_note":
        return [`- ${prLabel(e.prUrl)} (${e.change}): ${oneLine(e.text, 600)}`, []];
      case "request":
        return [`- ${e.request} ${e.what}: ${e.outcome}`, e.tail !== undefined && e.tail.trim() ? body(e.tail) : []];
      case "cap_raised":
        return [
          `- cap raised to ${e.maxAgents}: ${e.free} slot${e.free === 1 ? "" : "s"} free; queued agents already started`,
          [],
        ];
      case "decision_overturned":
        if (!e.replacedBy) {
          return [
            `- the human revoked ${e.decision} ${e.key} (was ${quote(e.was)}): ${quote(e.why)}; it is open again, so ask before deciding it`,
            [],
          ];
        }
        return [
          `- the human replaced ${e.decision} ${e.key} ${quote(e.was)} with ${e.replacedBy[0]} ${quote(e.replacedBy[1])}: ${quote(e.why)}; follow ${e.replacedBy[0]} from now on`,
          [],
        ];
      case "checklist_removed": {
        const n = e.items.length;
        return [
          `- the human took ${n === 1 ? "1 item" : `${n} items`} off the checklist: ${e.items
            .map(([id, text]) => `${id} ${quote(text)}`)
            .join(", ")}; leave ${n === 1 ? "it" : "them"} off unless they ask again`,
          [],
        ];
      }
      case "retagged":
        return [`- ${e.who} moved a message (${e.message}) from ${e.from} to ${e.to}: ${quote(e.text)}`, []];
    }
  })();
  return [head, ...rest].join("\n");
}
