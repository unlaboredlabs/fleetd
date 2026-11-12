// The lead digest's "Merge train" lines from plain data, with no train behind them (digest.ts reads the train's
// records for them): each train's head and queue, what merged since the lead's last wake, and what is parked with its
// author.
import type { Change, TrainState } from "../../shared/contracts.ts";
import { TOOLS_FAILED } from "../reviews/rules.ts";
import { parseMs } from "../store/time.ts";
import { WAITING_FOR_RUNNERS } from "./next_rules.ts";
import { APPROVAL, HELD, LEFT_OUT, timedOut } from "./notes.ts";
import { DRAFT, isDraft } from "./states.ts";

export type TrainFacts = { trains: TrainState[]; changes: Change[] };

const PARKED = ["needs_rebase", "ci_failed"];

function oneLine(text: string, max: number): string {
  const flat = text.split(/\s+/).filter(Boolean).join(" ");
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

const shortSha = (sha: string | undefined) => (sha !== undefined ? ` as ${sha.slice(0, 12)}` : "");
const pr = (c: Change) => `${c.repo}#${c.prNumber}`;
const by = (c: Change) => (c.taskId !== undefined ? `, by ${c.taskId}` : "");

/** `Date.parse(updatedAt) > since`; an unreadable time compares false. */
function updatedAfter(c: Change, sinceMs: number | undefined): boolean {
  if (sinceMs === undefined) return true;
  const at = parseMs(c.updatedAt);
  return at !== undefined && at > sinceMs;
}

function stateOf(changes: Change[], train: TrainState): string {
  const byId = new Map(changes.map((c) => [c.changeId, c]));
  const queue = train.queue.map((id) => {
    const c = byId.get(id);
    if (!c) return id;
    if (isDraft(c)) return `${id} ${DRAFT}`;
    // A ready PR that waits on a person says so.
    if (c.state === "ready" && c.lastError === APPROVAL) return `${id} waiting for a person's approval`;
    if (c.state === "ready" && c.lastError === HELD) return `${id} held by its \`hold\` label`;
    // A ready PR the batch left out says why.
    if (c.state === "ready" && c.lastError?.startsWith(LEFT_OUT)) return `${id} ready (${oneLine(c.lastError, 100)})`;
    // A review whose reviewer's tools failed says so.
    if (c.state === "reviewing" && c.lastError?.startsWith(TOOLS_FAILED)) return `${id} reviewing (${oneLine(c.lastError, 100)})`;
    return `${id} ${c.state}`;
  });
  const parts: string[] = [];
  if (train.head !== undefined) {
    const c = byId.get(train.head);
    let state = "";
    if (c) {
      const waiting = c.state === "ci" && c.lastError?.startsWith(WAITING_FOR_RUNNERS) ? `: ${c.lastError}` : "";
      state = ` (${c.state})${waiting}`;
    }
    parts.push(`now ${train.head}${state}`);
  }
  parts.push(queue.length === 0 ? "queue empty" : `queue ${queue.slice(0, 8).join(", ")}${queue.length > 8 ? ` +${queue.length - 8}` : ""}`);
  return parts.join("; ");
}

/** The lead digest's "Merge train" lines. `since` is the lead's last wake. */
export function leadTrainLines(facts: TrainFacts, since?: string): string[] {
  // Date.parse of an unreadable `since` is NaN: nothing is "after" it.
  const sinceMs = since === undefined ? undefined : (parseMs(since) ?? Number.MAX_SAFE_INTEGER);
  const lines = facts.trains.map((t) => `- ${t.repo}: ${stateOf(facts.changes, t)}`);
  const when = since !== undefined ? " since your last wake" : "";
  for (const c of facts.changes.filter((c) => c.state === "merged" && updatedAfter(c, sinceMs))) {
    lines.push(`- ${c.changeId} merged${when}: ${pr(c)}${shortSha(c.mergedSha)}${c.taskId !== undefined ? ` (by ${c.taskId})` : ""}`);
  }
  for (const c of facts.changes.filter((c) => PARKED.includes(c.state))) {
    const then = timedOut(c)
      ? "No push needed; the train puts it back in the queue once its checks finish green"
      : "Back with its author; the train retries its next push";
    lines.push(`- ${c.changeId} ${c.state}: ${pr(c)}${by(c)}; ${oneLine(c.lastError ?? "", 160)}. ${then}`);
  }
  return lines;
}
