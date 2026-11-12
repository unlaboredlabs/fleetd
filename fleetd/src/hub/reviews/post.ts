// The agent reviewer's verdict on the PR itself, for the people who read it on GitHub: one comment per PR, never an
// approval or a request for changes, naming the commit it reviewed. A re-review edits that comment, keeping one line
// per earlier round, so a PR gets one comment however often it is reviewed. Marked, so it is never read back as a
// person's review (people.ts). A post GitHub refuses is logged and holds nothing.
import type { Database } from "bun:sqlite";
import type { Change } from "../../shared/contracts.ts";
import type { TrainGitHub } from "../train/github.ts";
import { earlierRounds, type Posted, reviewComment, type Round, roundsAfter } from "./comment.ts";
import { prKey } from "./verdicts.ts";

export { earlierRounds, type Posted, reviewComment, type Round, ROUNDS_KEPT, roundsAfter, SUMMARY_MAX } from "./comment.ts";

const ACCEPT = "Accept: application/vnd.github+json";

/** Posts the verdict on the Change's PR, or edits the comment an earlier round posted. */
export async function postVerdict(github: TrainGitHub, db: Database, change: Change, v: Posted): Promise<void> {
  const key = prKey(change.prUrl);
  const row = db.query<{ comment_id: number; rounds: string }, [string]>("SELECT comment_id, rounds FROM review_posts WHERE pr_key = ?1").get(key);
  let rounds: Round[] = [];
  try {
    rounds = row ? (JSON.parse(row.rounds) as Round[]) : [];
  } catch {}
  const earlier = earlierRounds(rounds, v.sha);
  const body = reviewComment(change.repo, v, earlier);
  const repo = change.repo;
  let id = row?.comment_id;
  if (id !== undefined) {
    const edited = await github.exchange("PATCH", `repos/${repo}/issues/comments/${id}`, ACCEPT, [["body", body]]);
    // Someone deleted it: a new one.
    if (!edited.ok && edited.status !== 404) throw new Error(`GitHub refused to edit the review comment (HTTP ${edited.status}): ${edited.message}`);
    if (!edited.ok) id = undefined;
  }
  if (id === undefined) {
    const made = await github.exchange("POST", `repos/${repo}/issues/${change.prNumber}/comments`, ACCEPT, [["body", body]]);
    if (!made.ok) throw new Error(`GitHub refused the review comment (HTTP ${made.status}): ${made.message}`);
    const n = (JSON.parse(made.text) as { id?: unknown }).id;
    if (typeof n !== "number") throw new Error("GitHub's answer to the review comment had no id");
    id = n;
  }
  const kept = roundsAfter(earlier, v);
  db.query("INSERT OR REPLACE INTO review_posts (pr_key, comment_id, rounds) VALUES (?1, ?2, ?3)").run(key, id, JSON.stringify(kept));
}
