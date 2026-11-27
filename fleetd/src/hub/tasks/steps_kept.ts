// A finished agent's step log, kept on the workspace: at each end of its task, its thread's newest steps are saved
// (`task_steps`), and agent_work reads them for a thread no longer running, so its page shows what it did after its
// node, box or worktree is gone. Bounded as kept_rules.ts says: KEPT_STEPS steps in at most KEPT_MAX_BYTES, for
// KEPT_FOR_MS after the end.
import type { Database } from "bun:sqlite";
import type { TaskId, ThreadRef, WorkStep } from "../../shared/contracts.ts";
import { KEPT_FOR_MS, keptSteps } from "./kept_rules.ts";

export const KeptSteps = {
  /** Saves `newestFirst` for `thread`, cut to the bounds, oldest first; replaces what an earlier end saved. */
  save(db: Database, thread: ThreadRef, taskId: TaskId, newestFirst: WorkStep[], nowMs: number): void {
    const steps = keptSteps(newestFirst);
    db.query(
      `INSERT INTO task_steps (machine_id, thread_id, task_id, ended_ms, steps) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (machine_id, thread_id) DO UPDATE SET task_id = excluded.task_id, ended_ms = excluded.ended_ms, steps = excluded.steps`,
    ).run(thread.machineId, thread.threadId, taskId, nowMs, JSON.stringify(steps));
  },

  /** The steps kept for `thread`, oldest first; undefined when none are. */
  read(db: Database, thread: ThreadRef): WorkStep[] | undefined {
    const row = db
      .query<{ steps: string }, [string, string]>("SELECT steps FROM task_steps WHERE machine_id = ? AND thread_id = ?")
      .get(thread.machineId, thread.threadId);
    if (!row) return undefined;
    try {
      const steps = JSON.parse(row.steps) as unknown;
      return Array.isArray(steps) ? (steps as WorkStep[]) : undefined;
    } catch {
      return undefined;
    }
  },

  /** Deletes the steps of threads that ended KEPT_FOR_MS ago; how many went. */
  prune(db: Database, nowMs: number): number {
    return db.query("DELETE FROM task_steps WHERE ended_ms < ?").run(nowMs - KEPT_FOR_MS).changes;
  },
};
