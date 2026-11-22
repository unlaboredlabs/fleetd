// The readiness gate and the text reviewers and authors get. Pure; the gate
// feeds them the Change and what its review tasks recorded.
import type { Change } from "../../shared/contracts.ts";
import { fixYourPr, type PromptSetLike } from "../train/prompts.ts";

/** A recorded verdict of one of the Change's review tasks. */
export type BoundReview = { taskId: string; patchId: string; blocking: number };

export type Gate = { ready: boolean; waitingForHead: boolean; why: string };

/** Ready once a clean verdict is bound to exactly `patchId`; any blocking verdict on it holds it until a new head. */
export function gate(patchId: string, reviews: BoundReview[]): Gate {
  const current = reviews.filter((r) => r.patchId === patchId);
  const blocked = current.filter((r) => r.blocking > 0).map((r) => `${r.taskId} (${r.blocking})`);
  const short = patchId.slice(0, 12);
  if (blocked.length > 0) return { ready: false, waitingForHead: true, why: `blocking findings from ${blocked.join(", ")}; waiting for a new head` };
  const clean = current[0];
  return clean
    ? { ready: true, waitingForHead: false, why: `${clean.taskId} reviewed patch ${short} clean` }
    : { ready: false, waitingForHead: false, why: `waiting for a clean review of patch ${short}` };
}

/**
 * A reviewer's prompt: the PR diff ref; the author's `Unsure:` line from the PR's `body`, to judge; `reviewed`, an
 * earlier round's head, starts a re-review from what changed. The body is required so a caller can't drop the line.
 */
export function reviewPrompt(set: PromptSetLike, change: Change, reviewed: string | undefined, body: string | null | undefined): string {
  const parts = [set.render("review.reviewer", { prUrl: change.prUrl, repo: change.repo, prNumber: change.prNumber, headSha: change.headSha })];
  const unsure = unsureLine(body);
  if (unsure !== undefined) parts.push(set.render("review.unsure", { unsure }));
  if (reviewed !== undefined && reviewed !== change.headSha) parts.push(set.render("review.delta", { reviewedSha: reviewed, headSha: change.headSha }));
  return parts.join("\n\n");
}

/** The longest `Unsure:` line a reviewer gets, in characters. */
export const UNSURE_MAX = 400;

const UNSURE = /^[\s>*_-]*unsure[*_]*\s*:[*_]*\s*(.*)$/i;
const NO_DOUBT = /^(nothing|none|n\/a|-)?[.!]?$/i;

/** What a PR description's last `Unsure:` line names, on one line; nothing when it has none, or it names no doubt. */
export function unsureLine(body: string | null | undefined): string | undefined {
  const lines = (typeof body === "string" ? body : "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = UNSURE.exec(lines[i]!);
    if (!m) continue;
    const said = oneLine(m[1]!.replace(/[*_]+$/, "").replaceAll('"', "'"), UNSURE_MAX);
    return NO_DOUBT.test(said) ? undefined : said;
  }
  return undefined;
}

/** The follow-up to a reviewer whose turn ended without a verdict: finish in this turn and report. */
export const unreportedMessage = (set: PromptSetLike, change: Change, headSha: string) =>
  set.render("review.unreported", { prUrl: change.prUrl, headSha });

/** A rebase's conflict resolution to review. */
export type Conflicts = { reviewedSha: string; reviewedBase: string; base: string; files: string[] };

/** The short reviewer's prompt for a rebase that only resolved conflicts with the base. */
export function conflictsPrompt(set: PromptSetLike, change: Change, c: Conflicts): string {
  return set.render("review.conflicts", {
    prUrl: change.prUrl,
    headSha: change.headSha,
    reviewedSha: c.reviewedSha,
    reviewedBase: c.reviewedBase,
    base: c.base,
    files: c.files.map((f) => `\`${f}\``).join(", "),
  });
}

/** The start of a Change's `lastError` while its reviewer's fleetd tools failed. */
export const TOOLS_FAILED = "review tools failed";

const TOOLS = ["mcp", "fleetd tool", "fleetd's tool", "tools server", "tool server", "report tool", "verdict tool", "`report`", "mcp__fleetd"];
const FAILING = [
  "fail",
  "error",
  "unavailable",
  "not available",
  "isn't available",
  "aren't available",
  "not found",
  "no such",
  "missing",
  "not connected",
  "could not connect",
  "couldn't connect",
  "can't connect",
  "cannot connect",
  "could not reach",
  "couldn't reach",
  "can't reach",
  "cannot reach",
];
const UNRECORDED = ["could not record", "couldn't record", "can't record", "cannot record", "unable to record", "failed to record", "no way to record", "not able to record"];

/** Whether a reviewer that ended without a verdict did so because it couldn't use fleetd's tools, by its final text. */
export function toolsFailed(tail: string): boolean {
  const t = tail.toLowerCase();
  const has = (words: string[]) => words.some((w) => t.includes(w));
  return t.includes("enoent") || (has(TOOLS) && has(FAILING)) || has(UNRECORDED);
}

export type FindingsVerdict = { taskId: string; prHeadSha: string; blocking: number; nonBlocking: number; summary: string };

/** The message that sends blocking findings back to the task that wrote the code. */
export function findingsMessage(set: PromptSetLike, change: Change, v: FindingsVerdict): string {
  const problem = `review ${v.taskId} at ${v.prHeadSha.slice(0, 12)} found ${v.blocking} blocking finding${v.blocking === 1 ? "" : "s"} (${v.nonBlocking} non-blocking)`;
  return fixYourPr(set, change, problem, v.summary);
}

/** fleetd's own ids in a PR title, such as "(W41)" or "[D128, T7]": the human never needs them. */
const INTERNAL_IDS = /\s*[([]\s*[WTXDSQ]\d+(?:\s*[,/;]?\s*[WTXDSQ]\d+)*\s*[)\]]/g;

/** A review task's title in plain words: what it checks, by the PR's title, or by its number. */
export function reviewTitle(prTitle: string | undefined, prNumber: number): string {
  const plain = prTitle?.replace(INTERNAL_IDS, "").trim();
  return plain ? oneLine(`Checking: ${plain}`, 80) : `Checking PR #${prNumber}`;
}

/** One line, at most `max` characters. */
export function oneLine(text: string, max: number): string {
  const flat = text.split(/\s+/).filter(Boolean).join(" ");
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}
