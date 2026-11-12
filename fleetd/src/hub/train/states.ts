// A Change's states and the text a record keeps of it (records.ts stores them): what other areas and another
// repository read without the database.
import type { Change, ChangeState } from "../../shared/contracts.ts";

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
