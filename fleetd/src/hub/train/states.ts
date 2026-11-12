// A Change's states, the text a record keeps of it and its JSON, the train's waits and rows (records.ts stores them):
// what other areas and another repository read without the database.
import type { Change, ChangeState, ProjectRef } from "../../shared/contracts.ts";

/** States a Change waits in, in its train's queue. */
export const QUEUED_STATES: ChangeState[] = ["queued", "reviewing", "ready"];
/** States of the Change the train is working on. */
export const HEAD_STATES: ChangeState[] = ["rebasing", "ci", "merging"];
/** No way back from these; a new enqueue of the PR makes a new Change. */
export const TERMINAL_STATES: ChangeState[] = ["merged", "refused", "abandoned"];
export const ALL_STATES: ChangeState[] = [
  "queued",
  "reviewing",
  "ready",
  "rebasing",
  "ci",
  "merging",
  "merged",
  "needs_rebase",
  "ci_failed",
  "refused",
  "abandoned",
];

/** The `lastError` of a draft PR's Change: recorded, but at the back of the line until its PR is marked ready. */
export const DRAFT = "draft, waiting to be marked ready";
export const isDraft = (change: Change) => change.lastError === DRAFT;

export const parseState = (s: string): ChangeState | undefined => (ALL_STATES as string[]).includes(s) ? (s as ChangeState) : undefined;

/** `lastError` as stored: at most 2000 characters, 1999 and "…" when cut. */
export function errorText(text: string): string {
  const chars = [...text];
  return chars.length > 2000 ? `${chars.slice(0, 1999).join("")}…` : text;
}

/** A GitHub PR URL's repo and number: `https://github.com/<owner>/<name>/pull/<n>`. */
export function parsePrUrl(url: string): { repo: string; number: number } | undefined {
  const m = url.match(/^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]*)$/);
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined;
}

/** A commit the train merged onto `base`, whose checks outside the fast set it watches there. */
export type Watch = { repo: string; sha: string; base: string; projectRef: ProjectRef; prUrl: string; sinceMs: number };

/**
 * The kinds of `train_waits`: no check started on a Change's head yet, its review's findings hold it, its regeneration,
 * and a person it waits on, told of at the patch id in its `head`.
 */
export const WAIT_UNSTARTED = "unstarted";
export const WAIT_BLOCKED = "blocked";
export const WAIT_REGEN = "regen";
export const WAIT_PERSON = "person";
/** A wait's state before it came to anything. */
export const WAITING = "waiting";

/** One of the train's waits on a Change, kept across restarts (`train_waits`): its head, since when there, its state. */
export type Wait = { head: string; sinceMs: number; state: string };

/** What the watch did about a check's run on a merged commit (`putWatchCheck`): its name, run id, what, and when. */
export type WatchCheck = { name: string; runId: number; did: string; atMs: number };

export type TrainRow = {
  repo: string;
  projectRef: ProjectRef;
  /** Merges outside the train after this are reported; it moves past each one reported. */
  watchSinceMs: number;
};

export type ListFilter = { projectRef?: ProjectRef; repo?: string; state?: ChangeState; limit: number };

/** A Change in the Rust struct's field order, its optional fields left out when absent, as serde writes it. */
export function encode(c: Change): string {
  const out: Record<string, unknown> = {
    changeId: c.changeId,
    projectRef: { machineId: c.projectRef.machineId, projectId: c.projectRef.projectId },
    repo: c.repo,
    prNumber: c.prNumber,
    prUrl: c.prUrl,
    branch: c.branch,
  };
  if (c.taskId !== undefined) out.taskId = c.taskId;
  out.workstreamId = c.workstreamId;
  out.headSha = c.headSha;
  if (c.patchId !== undefined) out.patchId = c.patchId;
  out.state = c.state;
  out.reviews = c.reviews;
  if (c.position !== undefined) out.position = c.position;
  if (c.lastError !== undefined) out.lastError = c.lastError;
  if (c.mergedSha !== undefined) out.mergedSha = c.mergedSha;
  if (c.after !== undefined && c.after.length > 0) out.after = c.after;
  out.createdAt = c.createdAt;
  out.updatedAt = c.updatedAt;
  return JSON.stringify(out);
}
