import { Task, type ProjectRef, type TaskCounts, type TaskId, type TaskState, type ThreadRef, type WorkstreamId } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HubDb from "../store/HubDb.ts";

export interface StoredTask {
  readonly task: Task;
  /** A `task message` that waits for a slot or lease before it goes out. */
  readonly pendingMessage?: string;
}

export const ENDED_STATES: ReadonlyArray<TaskState> = ["done", "failed", "cancelled"];

export class TaskRecords extends Context.Service<
  TaskRecords,
  {
    /** Numbers the task (`T<n>`) and stores it. */
    readonly create: (task: Omit<Task, "taskId">) => Effect.Effect<Task>;
    readonly get: (taskId: TaskId) => Effect.Effect<StoredTask | undefined>;
    readonly put: (stored: StoredTask) => Effect.Effect<void>;
    readonly byThread: (ref: ThreadRef) => Effect.Effect<StoredTask | undefined>;
    /** Oldest first, every project. */
    readonly queued: () => Effect.Effect<ReadonlyArray<StoredTask>>;
    /** Newest first. */
    readonly list: (filter: {
      readonly ref?: ProjectRef;
      readonly state?: TaskState;
      readonly workstreamId?: WorkstreamId;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<Task>>;
    /** The digest's tasks: every queued, running or idle one, and those that ended after `since`. Newest first. */
    readonly forDigest: (ref: ProjectRef, since: string | undefined, limit: number) => Effect.Effect<ReadonlyArray<Task>>;
    /** The project's tasks by state. */
    readonly counts: (ref: ProjectRef) => Effect.Effect<TaskCounts>;
    /** Every thread a task of the project ran in, so thread lists can leave them out. */
    readonly threadIds: (ref: ProjectRef) => Effect.Effect<ReadonlySet<string>>;
  }
>()("fleetd/tasks/TaskRecords") {}

const decodeTask = Schema.decodeSync(Schema.fromJsonString(Task));
const encodeTask = Schema.encodeSync(Schema.fromJsonString(Task));
const numberOf = (taskId: TaskId) => Number(taskId.slice(1));

const make = Effect.gen(function* () {
  const { db } = yield* HubDb.HubDb;

  const sql = {
    insert: db.prepare(
      "INSERT INTO tasks (machine_id, project_id, workstream_id, state, data) VALUES (?, ?, ?, ?, '') RETURNING n",
    ),
    get: db.prepare("SELECT data, pending_message FROM tasks WHERE n = ?"),
    put: db.prepare("UPDATE tasks SET state = ?, thread_id = ?, ended_at = ?, pending_message = ?, data = ? WHERE n = ?"),
    byThread: db.prepare("SELECT data, pending_message FROM tasks WHERE machine_id = ? AND thread_id = ? ORDER BY n DESC LIMIT 1"),
    queued: db.prepare("SELECT data, pending_message FROM tasks WHERE state = 'queued' ORDER BY n"),
    list: db.prepare(
      `SELECT data FROM tasks
       WHERE ($machine IS NULL OR machine_id = $machine) AND ($project IS NULL OR project_id = $project)
         AND ($state IS NULL OR state = $state) AND ($workstream IS NULL OR workstream_id = $workstream)
       ORDER BY n DESC LIMIT $limit`,
    ),
    forDigest: db.prepare(
      `SELECT data FROM tasks
       WHERE machine_id = $machine AND project_id = $project
         AND (state IN ('queued', 'running', 'idle') OR ($since IS NULL OR ended_at > $since))
       ORDER BY n DESC LIMIT $limit`,
    ),
    counts: db.prepare("SELECT state, COUNT(*) AS n FROM tasks WHERE machine_id = ? AND project_id = ? GROUP BY state"),
    threadIds: db.prepare("SELECT thread_id FROM tasks WHERE machine_id = ? AND project_id = ? AND thread_id IS NOT NULL"),
  };

  const storedOf = (row: Record<string, unknown> | undefined): StoredTask | undefined =>
    row === undefined
      ? undefined
      : {
          task: decodeTask(String(row.data)),
          ...(row.pending_message === null ? {} : { pendingMessage: String(row.pending_message) }),
        };

  const write = ({ task, pendingMessage }: StoredTask) => {
    sql.put.run(task.state, task.threadRef?.threadId ?? null, task.endedAt ?? null, pendingMessage ?? null, encodeTask(task), numberOf(task.taskId));
  };

  return TaskRecords.of({
    create: (input) =>
      Effect.sync(() =>
        HubDb.transaction(db, () => {
          const n = Number(sql.insert.get(input.projectRef.machineId, input.projectRef.projectId, input.workstreamId, input.state)?.n);
          const task = Task.make({ ...input, taskId: `T${n}` as TaskId });
          write({ task });
          return task;
        }),
      ),
    get: (taskId) => Effect.sync(() => storedOf(sql.get.get(numberOf(taskId)))),
    put: (stored) => Effect.sync(() => write(stored)),
    byThread: (ref) => Effect.sync(() => storedOf(sql.byThread.get(ref.machineId, ref.threadId))),
    queued: () => Effect.sync(() => sql.queued.all().map((row) => storedOf(row)!)),
    list: (filter) =>
      Effect.sync(() =>
        sql.list
          .all({
            machine: filter.ref?.machineId ?? null,
            project: filter.ref?.projectId ?? null,
            state: filter.state ?? null,
            workstream: filter.workstreamId ?? null,
            limit: filter.limit,
          })
          .map((row) => decodeTask(String(row.data))),
      ),
    forDigest: (ref, since, limit) =>
      Effect.sync(() =>
        sql.forDigest
          .all({ machine: ref.machineId, project: ref.projectId, since: since ?? null, limit })
          .map((row) => decodeTask(String(row.data))),
      ),
    counts: (ref) =>
      Effect.sync(() => {
        const counts: Record<TaskState, number> = { queued: 0, running: 0, idle: 0, done: 0, failed: 0, cancelled: 0 };
        for (const row of sql.counts.all(ref.machineId, ref.projectId)) counts[String(row.state) as TaskState] = Number(row.n);
        return counts;
      }),
    threadIds: (ref) => Effect.sync(() => new Set(sql.threadIds.all(ref.machineId, ref.projectId).map((row) => String(row.thread_id)))),
  });
});

export const layer = Layer.effect(TaskRecords, make);
