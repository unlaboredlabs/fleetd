// `train.start` (crates/fleetd/src/hub/serve start_loops): the train follows finished writers and removed projects and
// runs each repo's loop; its lead calls and its project_get fields go in with it.
import type { Hub } from "../api/hub.ts";
import { stopHooks } from "../chat/stop.ts";
import { executorHooks } from "../executor/hooks.ts";
import { reviewedHeads } from "../reviews/verdicts.ts";
import { registerLeadCalls } from "./calls.ts";
import { trainArea } from "./index.ts";
import { parsePrUrl } from "./records.ts";
import { prsGithub } from "../prs/index.ts";
import { openBlocking } from "../reviews/read.ts";
import { type TaskHooks, taskHooks } from "../tasks/ports.ts";
import { upstream } from "./next.ts";

/** Trains in a project_get outcome (api limits `TRAINS`). */
const TRAINS = 10;

export function start(hub: Hub): void {
  const { train, reviews } = trainArea(hub);
  registerLeadCalls(hub);
  // What tasks reach the train and its review gate by, as the Rust hub's `hub.train` and `hub.reviews`: a finished
  // writer's PR found after its result, the train's GitHub reader (agents' `wait_ci` polls and branch PR reads), where
  // an upstream PR stands (`wait_ci` with `merged`), and the reviewers and a PR's still-open blocking findings.
  Object.assign(taskHooks(hub), {
    train: {
      onTaskPr: (taskId: string) => void train.onTaskPr(taskId).catch((error) => console.warn(`train: ${taskId}'s PR not queued:`, error)),
      github: train.github,
      merges: { upstream: (url) => upstream(train, url) },
    },
    reviews: { isReviewer: (taskId: string) => reviews.isReviewer(taskId), openBlocking: (pr: string) => openBlocking(hub.db, pr) },
  } satisfies Pick<TaskHooks, "train" | "reviews">);
  // The head a review task reviewed when its verdict doesn't say: its round's head, else its PR's head now.
  reviewedHeads(hub).of = async (task) => {
    const round = hub.db.conn
      .query<{ head_sha: string }, [string]>(
        `SELECT p.head_sha FROM review_tasks t JOIN review_patch_ids p ON p.change_id = t.change_id AND p.patch_id = t.patch_id
           WHERE t.task_id = ?1 LIMIT 1`,
      )
      .get(task.taskId);
    if (round) return round.head_sha;
    const pr = task.pr !== undefined ? parsePrUrl(task.pr) : undefined;
    if (!pr) return undefined;
    const head = (await prsGithub(hub).detail(pr.repo, pr.number)).value?.pull.headRefOid.toLowerCase();
    return head !== undefined && /^[0-9a-f]{40}$/.test(head) ? head : undefined;
  };
  executorHooks(hub).extendProjectGet((_hub, r) => {
    const own = train.records.trains().filter((t) => t.projectRef.machineId === r.machineId && t.projectRef.projectId === r.projectId);
    const trains = own.slice(0, TRAINS).map((t) => train.state(t.repo));
    return { fields: trains.length > 0 ? { trains } : {}, ...(own.length > TRAINS ? { truncated: true } : {}) };
  });
  // A writer's `gh pr create` (any command of a write task that prints a PR URL) starts the train's ready pass at once,
  // so the slice is queued and reviewed while the writer works on (calls.rs `watch_writer_prs`).
  executorHooks(hub).onPrFound((thread) => {
    const row = hub.db.conn
      .query<{ data: string }, [string, string]>("SELECT data FROM tasks WHERE machine_id = ? AND thread_id = ?")
      .get(thread.machineId, thread.threadId);
    if (!row) return;
    const task = JSON.parse(row.data) as { kind?: string; projectRef?: { machineId: string; projectId: string } };
    if (task.kind === "write" && task.projectRef) train.writerOpenedPr(task.projectRef);
  });
  // A stopped order's PRs leave the train (chat_stop, project_stop), through the chat area's hook.
  stopHooks(hub).takeLeftovers = (r, workstreamId, why) => train.takeLeftovers(r, workstreamId, why).map((c) => c.prNumber);
  train.start();
}
