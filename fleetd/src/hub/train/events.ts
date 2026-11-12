// The lead's lines about PRs (its `Pr*` events): what the train and the
// review gate wake a lead with.
import { clip } from "./text.ts";

/** `text` on one line, whitespace runs as one space, at most `max` UTF-16 units with "…" when cut. */
export function oneLine(text: string, max: number): string {
  const flat = text.split(/\s+/).filter(Boolean).join(" ");
  return flat.length > max ? `${clip(flat, max - 1)}…` : flat;
}

/** `PR #12` from a GitHub PR URL; the URL itself when it has no number. */
export function prLabel(url: string): string {
  const at = url.lastIndexOf("/pull/");
  const n = at < 0 ? "" : url.slice(at + 6);
  return n !== "" && /^\d+$/.test(n) ? `PR #${n}` : `PR ${url}`;
}

/** An agent's text as `  > ` lines. */
export function body(text: string): string[] {
  const t = text.trim();
  if (t === "") return ["  > (no final message)"];
  return t.split("\n").map((l) => `  > ${l}`.trimEnd());
}

const lines = (head: string, rest: string[] = []) => [head, ...rest].join("\n");

export const prMerged = (change: string, prUrl: string, sha: string, by?: string) =>
  lines(`- ${prLabel(prUrl)} merged${sha}: ${prUrl} (${change}${by !== undefined ? `, by ${by}` : ""})`);

export const prLeft = (change: string, prUrl: string, why: string) => lines(`- ${prLabel(prUrl)} left the train: ${why} (${change}, ${prUrl})`);

export const prGaveUp = (change: string, prUrl: string, why: string, tries: number) =>
  lines(`- ${prLabel(prUrl)} not merged: ${why}; the train gave up after ${tries} tries (${change}, ${prUrl})`);

export const prReviewNotRecorded = (change: string, prUrl: string, task: string, next: string, tail: string) =>
  lines(
    `- ${prLabel(prUrl)} verdict not recorded: the reviewer ${task} ended without one, so it counts as no approval; ${next} reviews it once more (${change}, ${prUrl})`,
    body(tail),
  );

export const prReviewStalled = (change: string, prUrl: string, task: string, tries: number, tail: string) =>
  lines(
    `- ${prLabel(prUrl)} not reviewed, verdict not recorded: ${tries} reviewers in a row ended without one, the last ${task}; the train starts no more (${change}, ${prUrl})`,
    body(tail),
  );

export const prRefused = (prUrl: string, task: string, message: string, fix?: string) =>
  lines(`- ${prLabel(prUrl)} from ${task} refused by the train: ${message}${fix !== undefined ? ` Fix: ${fix}.` : ""} (${prUrl})`);

export const prNote = (change: string, prUrl: string, text: string) => lines(`- ${prLabel(prUrl)} (${change}): ${oneLine(text, 600)}`);
