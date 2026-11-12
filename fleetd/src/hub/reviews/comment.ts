// The review gate's comment on a PR, without gh or the database (post.ts posts and edits it): the latest verdict
// whole, earlier rounds a line each, and the mark that tells it from people's.
import { redact } from "../../shared/redact.ts";
import { clip } from "../train/text.ts";
import { REVIEW_MARK } from "./people_rules.ts";

export const SUMMARY_MAX = 3000;
export const ROUNDS_KEPT = 10;

export type Posted = { sha: string; blocking: number; nonBlocking: number; summary: string };
export type Round = { sha: string; blocking: number; nonBlocking: number };

export const counts = (r: Round) =>
  r.blocking === 0 ? `no blocking findings${r.nonBlocking > 0 ? ` (${r.nonBlocking} non-blocking)` : ""}` : `${r.blocking} blocking, ${r.nonBlocking} non-blocking`;

/** The comment's text: the latest verdict whole, earlier rounds a line each. */
export function reviewComment(repo: string, v: Posted, earlier: Round[]): string {
  const commit = `[\`${v.sha.slice(0, 12)}\`](https://github.com/${repo}/commit/${v.sha})`;
  const lines = [`**fleetd's agent review** of ${commit}: ${counts(v)}.`, "", clip(redact(v.summary.trim()), SUMMARY_MAX), ""];
  if (earlier.length > 0) lines.push(`Earlier rounds: ${earlier.map((r) => `\`${r.sha.slice(0, 12)}\` ${counts(r)}`).join("; ")}.`, "");
  lines.push(
    "<sub>Posted by fleetd as a comment: it never approves or requests changes here. fleetd merges only once this " +
      "review has no blocking findings, and people's reviews here are answered.</sub>",
    "",
    REVIEW_MARK,
  );
  return lines.join("\n");
}

/** The earlier rounds a new verdict's comment lists: every other head's, the last ROUNDS_KEPT of them. */
export const earlierRounds = (rounds: Round[], sha: string) => rounds.filter((r) => r.sha !== sha).slice(-ROUNDS_KEPT);

/** The rounds kept once `v` is posted: the earlier ones, then its own. */
export const roundsAfter = (earlier: Round[], v: Posted): Round[] => [...earlier, { sha: v.sha, blocking: v.blocking, nonBlocking: v.nonBlocking }];
