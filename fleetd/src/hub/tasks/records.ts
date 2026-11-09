// Task rows: the Task as JSON in `data`, plus the columns queries filter on.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { ProjectRef, Task, TaskCounts, TaskId, TaskState, ThreadRef, WorkstreamId } from "../../shared/contracts.ts";
import type { WorktreeBase } from "../../shared/sessions.ts";
import * as repos from "../repos/store.ts";

export type StoredTask = {
  task: Task;
  /** A `task message` that waits for a slot before it goes out. */
  pendingMessage?: string;
};

export type TaskFilter = { projectRef?: ProjectRef; state?: TaskState; workstreamId?: WorkstreamId; limit: number };

export const ENDED_STATES: readonly TaskState[] = ["done", "failed", "cancelled"];

/** `T12` → 12; 0 for anything else, as the Rust hub reads it. */
export function numberOf(taskId: TaskId): number {
  const n = Number.parseInt(taskId.slice(1), 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * `list`'s query, naming only the filters that are set so SQLite can use an index for them: the `?1 IS NULL OR
 * col = ?1` form scanned the whole table on every board tick.
 */
export function listSql(filter: TaskFilter): [string, SQLQueryBindings[]] {
  let sql = "SELECT data FROM tasks WHERE 1";
  const args: SQLQueryBindings[] = [];
  if (filter.projectRef) {
    sql += " AND machine_id = ? AND project_id = ?";
    args.push(filter.projectRef.machineId, filter.projectRef.projectId);
  }
  if (filter.state !== undefined) {
    sql += " AND state = ?";
    args.push(filter.state);
  }
  if (filter.workstreamId !== undefined) {
    sql += " AND workstream_id = ?";
    args.push(filter.workstreamId);
  }
  sql += " ORDER BY n DESC LIMIT ?";
  args.push(filter.limit);
  return [sql, args];
}

/**
 * A row with no `repoId` (every row an older hub stored, and a plain directory's) reads as the project's own repo, or
 * none for a plain directory (W79).
 */
function decode(db: Database, data: string): Task {
  const task = JSON.parse(data) as Task;
  if (task.repoId === undefined) {
    const own = repos.own(db, task.projectRef);
    if (own) task.repoId = own.repoId;
  }
  return task;
}

type Row = { data: string; pending_message: string | null };

const storedOf = (db: Database, row: Row): StoredTask => ({
  task: decode(db, row.data),
  ...(row.pending_message !== null ? { pendingMessage: row.pending_message } : {}),
});

function write(db: Database, stored: StoredTask): void {
  const t = stored.task;
  for (const r of t.previousThreads ?? []) {
    db.query("INSERT OR IGNORE INTO task_threads (machine_id, thread_id, n) VALUES (?, ?, ?)").run(r.machineId, r.threadId, numberOf(t.taskId));
  }
  // A task that runs again may have its worktree back: the sweep looks at it afresh once it ends again.
  db.query(
    `UPDATE tasks SET state = ?1, thread_id = ?2, ended_at = ?3, pending_message = ?4, data = ?5,
               worktree = CASE WHEN ?1 IN ('done', 'failed', 'cancelled') THEN worktree END,
               worktree_tries = CASE WHEN ?1 IN ('done', 'failed', 'cancelled') THEN worktree_tries ELSE 0 END
             WHERE n = ?6`,
  ).run(t.state, t.threadRef?.threadId ?? null, t.endedAt ?? null, stored.pendingMessage ?? null, JSON.stringify(t), numberOf(t.taskId));
}

/** Over the hub's one SQLite connection. */
export const TaskRecords = {
  get(db: Database, taskId: TaskId): StoredTask | undefined {
    const row = db.query<Row, [number]>("SELECT data, pending_message FROM tasks WHERE n = ?").get(numberOf(taskId));
    return row ? storedOf(db, row) : undefined;
  },

  put(db: Database, stored: StoredTask): void {
    write(db, stored);
  },

  /**
   * An ended task, with its PR lookup marked pending (D67) or not, and its whole result when its tail cuts it
   * (undefined clears an earlier run's), in one write.
   */
  putEnded(db: Database, stored: StoredTask, prLookup: boolean, fullResult?: string): void {
    db.transaction(() => {
      write(db, stored);
      TaskRecords.setPrLookup(db, stored.task.taskId, prLookup);
      db.query("UPDATE tasks SET full_result = ? WHERE n = ?").run(fullResult ?? null, numberOf(stored.task.taskId));
    })();
  },

  /** The task's whole final result, kept when its tail cuts it. */
  fullResult(db: Database, taskId: TaskId): string | undefined {
    return db.query<{ full_result: string | null }, [number]>("SELECT full_result FROM tasks WHERE n = ?").get(numberOf(taskId))?.full_result ?? undefined;
  },

  /** Numbers the task (`T<n>`) and stores it. `task.taskId` is ignored. */
  create(db: Database, task: Task): Task {
    return db.transaction(() => {
      const row = db
        .query<{ n: number }, [string, string, string, string]>(
          "INSERT INTO tasks (machine_id, project_id, workstream_id, state, data) VALUES (?, ?, ?, ?, '') RETURNING n",
        )
        .get(task.projectRef.machineId, task.projectRef.projectId, task.workstreamId, task.state);
      const numbered = { ...task, taskId: `T${row?.n}` };
      write(db, { task: numbered });
      return numbered;
    })();
  },

  /** Marks the task's PR lookup pending (D67), or settled. */
  setPrLookup(db: Database, taskId: TaskId, pending: boolean): void {
    db.query("UPDATE tasks SET pr_lookup = ? WHERE n = ?").run(pending ? 1 : 0, numberOf(taskId));
  },

  prLookupPending(db: Database, taskId: TaskId): boolean {
    return Boolean(db.query<{ pr_lookup: number }, [number]>("SELECT pr_lookup FROM tasks WHERE n = ?").get(numberOf(taskId))?.pr_lookup);
  },

  /** The tasks whose PR lookup is pending, oldest first. */
  prLookups(db: Database): Task[] {
    return db.query<Row, []>("SELECT data, pending_message FROM tasks WHERE pr_lookup = 1 ORDER BY n").all().map((r) => storedOf(db, r).task);
  },

  /** The task that runs in the thread, or ran in it before a fresh restart (`previousThreads`). */
  byThread(db: Database, r: ThreadRef): StoredTask | undefined {
    const current = db
      .query<Row, [string, string]>("SELECT data, pending_message FROM tasks WHERE machine_id = ? AND thread_id = ? ORDER BY n DESC LIMIT 1")
      .get(r.machineId, r.threadId);
    if (current) return storedOf(db, current);
    const earlier = db
      .query<Row, [string, string]>(
        `SELECT t.data, t.pending_message FROM task_threads p JOIN tasks t ON t.n = p.n
             WHERE p.machine_id = ? AND p.thread_id = ?`,
      )
      .get(r.machineId, r.threadId);
    return earlier ? storedOf(db, earlier) : undefined;
  },

  /** The task whose session is `threadId` on any machine, now or before a fresh restart. */
  byThreadId(db: Database, threadId: string): StoredTask | undefined {
    const current = db
      .query<Row, [string]>("SELECT data, pending_message FROM tasks WHERE thread_id = ? ORDER BY n DESC LIMIT 1")
      .get(threadId);
    if (current) return storedOf(db, current);
    const earlier = db
      .query<Row, [string]>(
        `SELECT t.data, t.pending_message FROM task_threads p JOIN tasks t ON t.n = p.n
             WHERE p.thread_id = ? ORDER BY t.n DESC LIMIT 1`,
      )
      .get(threadId);
    return earlier ? storedOf(db, earlier) : undefined;
  },

  /** Where the project's newest launched worktree started. */
  latestBase(db: Database, r: ProjectRef): WorktreeBase | undefined {
    const row = db
      .query<{ data: string }, [string, string]>(
        `SELECT data FROM tasks WHERE machine_id = ? AND project_id = ? AND json_extract(data, '$.base') IS NOT NULL
             ORDER BY n DESC LIMIT 1`,
      )
      .get(r.machineId, r.projectId);
    return row ? (decode(db, row.data).base as WorktreeBase | undefined) : undefined;
  },

  /** `latestBase` for each of the machine's projects that launched a worktree. */
  latestBases(db: Database, machineId: string): [ProjectRef, WorktreeBase][] {
    return db
      .query<{ data: string }, [string]>(
        `SELECT data FROM tasks WHERE n IN (SELECT MAX(n) FROM tasks
               WHERE machine_id = ? AND json_extract(data, '$.base') IS NOT NULL GROUP BY project_id)
             ORDER BY n`,
      )
      .all(machineId)
      .flatMap((row) => {
        const t = decode(db, row.data);
        return t.base ? [[t.projectRef, t.base as WorktreeBase] as [ProjectRef, WorktreeBase]] : [];
      });
  },

  /** Oldest first, every project. */
  queued(db: Database): StoredTask[] {
    return db.query<Row, []>("SELECT data, pending_message FROM tasks WHERE state = 'queued' ORDER BY n").all().map((r) => storedOf(db, r));
  },

  /**
   * Ended tasks with a thread that ended before `before` whose worktree the sweep hasn't seen removed or given up
   * on, oldest first; with whether the person was already told it is kept.
   */
  unswept(db: Database, before: string): [Task, boolean][] {
    return db
      .query<{ data: string; worktree: string | null }, [string]>(
        `SELECT data, worktree FROM tasks WHERE state IN ('done', 'failed', 'cancelled') AND thread_id IS NOT NULL
               AND ended_at < ?1 AND (worktree IS NULL OR worktree = 'flagged') ORDER BY n`,
      )
      .all(before)
      .map((row) => [decode(db, row.data), row.worktree !== null]);
  },

  /** What the sweep found of an ended task's worktree: `removed`, `flagged` or `given_up`. */
  setWorktree(db: Database, taskId: TaskId, seen: string): void {
    db.query("UPDATE tasks SET worktree = ? WHERE n = ? AND state IN ('done', 'failed', 'cancelled')").run(seen, numberOf(taskId));
  },

  /** Counts a failed try at removing an ended task's worktree; returns the tries so far. */
  worktreeFailed(db: Database, taskId: TaskId): number {
    return (
      db
        .query<{ worktree_tries: number }, [number]>("UPDATE tasks SET worktree_tries = worktree_tries + 1 WHERE n = ? RETURNING worktree_tries")
        .get(numberOf(taskId))?.worktree_tries ?? 0
    );
  },

  /** The running tasks on a machine, oldest first. */
  runningOn(db: Database, machineId: string): Task[] {
    return db
      .query<{ data: string }, [string]>("SELECT data FROM tasks WHERE machine_id = ?1 AND state = 'running' ORDER BY n")
      .all(machineId)
      .map((r) => decode(db, r.data));
  },

  /** Newest first. */
  list(db: Database, filter: TaskFilter): Task[] {
    const [sql, args] = listSql(filter);
    return db
      .query<{ data: string }, SQLQueryBindings[]>(sql)
      .all(...args)
      .map((r) => decode(db, r.data));
  },

  /** The digest's tasks: every queued, running or idle one, and those that ended after `since`. Newest first. */
  forDigest(db: Database, r: ProjectRef, since: string | undefined, limit: number): Task[] {
    return db
      .query<{ data: string }, [string, string, string | null, number]>(
        `SELECT data FROM tasks
             WHERE machine_id = ?1 AND project_id = ?2
               AND (state IN ('queued', 'running', 'idle') OR (?3 IS NULL OR ended_at > ?3)
                    OR (state = 'done' AND 'T' || n IN (SELECT task_id FROM ci_waits)))
             ORDER BY n DESC LIMIT ?4`,
      )
      .all(r.machineId, r.projectId, since ?? null, limit)
      .map((row) => decode(db, row.data));
  },

  /** The project's queued, running and idle tasks. Newest first. */
  live(db: Database, r: ProjectRef, limit: number): Task[] {
    return db
      .query<{ data: string }, [string, string, number]>(
        `SELECT data FROM tasks
             WHERE machine_id = ?1 AND project_id = ?2 AND state IN ('queued', 'running', 'idle')
             ORDER BY n DESC LIMIT ?3`,
      )
      .all(r.machineId, r.projectId, limit)
      .map((row) => decode(db, row.data));
  },

  /** The project's tasks by state. */
  counts(db: Database, r: ProjectRef): TaskCounts {
    const counts: TaskCounts = { queued: 0, running: 0, idle: 0, done: 0, failed: 0, cancelled: 0 };
    for (const row of db
      .query<{ state: string; n: number }, [string, string]>(
        "SELECT state, COUNT(*) AS n FROM tasks WHERE machine_id = ? AND project_id = ? GROUP BY state",
      )
      .all(r.machineId, r.projectId)) {
      (counts as Record<string, number>)[row.state] = row.n;
    }
    return counts;
  },

  /** Every thread a task of the project ran in, earlier ones included, so thread lists can leave them out. */
  threadIds(db: Database, r: ProjectRef): Set<string> {
    return new Set(
      db
        .query<{ thread_id: string }, [string, string]>(
          `SELECT thread_id FROM tasks WHERE machine_id = ?1 AND project_id = ?2 AND thread_id IS NOT NULL
             UNION SELECT p.thread_id FROM tasks t JOIN task_threads p ON p.n = t.n
               WHERE t.machine_id = ?1 AND t.project_id = ?2`,
        )
        .all(r.machineId, r.projectId)
        .map((row) => row.thread_id),
    );
  },
};
