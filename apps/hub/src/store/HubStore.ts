import {
  Machine,
  ProjectSummary,
  ThreadSummary,
  type MachineId,
  type MachineStatus,
  type ProjectRef,
  type ThreadRef,
  type Timestamp,
} from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HubDb from "./HubDb.ts";

export type StoredThread = ThreadSummary & {
  readonly lastSequence?: number;
  /** T3's latest run id when this row was written. */
  readonly lastRunId?: string;
  /** That run's phase: a ThreadStatus, or "usage_limited". */
  readonly lastRunStatus?: string;
};

/** Caches of what the hub has seen of each machine. Reads return what was written; staleness is the reader's call. */
export class HubStore extends Context.Service<
  HubStore,
  {
    readonly machines: {
      /** `pubKey`, when given, replaces the machine's node key. */
      readonly upsert: (machine: Machine & { readonly pubKey?: string }) => Effect.Effect<void>;
      readonly get: (machineId: MachineId) => Effect.Effect<Machine | undefined>;
      readonly list: () => Effect.Effect<ReadonlyArray<Machine>>;
      /** Sets the status and `lastSeenAt = at`. A no-op for an unknown machine. */
      readonly setStatus: (machineId: MachineId, status: MachineStatus, at: Timestamp) => Effect.Effect<void>;
      /** Drops the machine's record (`fleetd machine remove`); its projects and threads stay cached. */
      readonly remove: (machineId: MachineId) => Effect.Effect<void>;
    };
    readonly projects: {
      readonly upsertMany: (machineId: MachineId, projects: ReadonlyArray<ProjectSummary>) => Effect.Effect<void>;
      /** Newest activity first. `query` matches title or workspace root, case-insensitively. */
      readonly list: (filter?: {
        readonly machineId?: MachineId;
        readonly query?: string;
      }) => Effect.Effect<ReadonlyArray<ProjectSummary>>;
      readonly get: (ref: ProjectRef) => Effect.Effect<ProjectSummary | undefined>;
      /** Drops the project and its cached threads, once T3 no longer has it. */
      readonly remove: (ref: ProjectRef) => Effect.Effect<void>;
    };
    readonly threads: {
      /** An absent `lastSequence`, `lastRunId` or `lastRunStatus` keeps the stored one. */
      readonly upsert: (thread: StoredThread) => Effect.Effect<void>;
      readonly get: (ref: ThreadRef) => Effect.Effect<StoredThread | undefined>;
      /** Threads whose last known status is "running", on every machine. */
      readonly listRunning: () => Effect.Effect<ReadonlyArray<ThreadSummary>>;
      /** Newest progress first. */
      readonly listByProject: (ref: ProjectRef, limit: number) => Effect.Effect<ReadonlyArray<ThreadSummary>>;
    };
    /** T3 shell `afterSequence` per machine. */
    readonly cursors: {
      readonly get: (machineId: MachineId) => Effect.Effect<number | undefined>;
      readonly set: (machineId: MachineId, seq: number) => Effect.Effect<void>;
    };
  }
>()("fleetd/store/HubStore") {}

const decodeMachine = Schema.decodeSync(Schema.fromJsonString(Machine));
const encodeMachine = Schema.encodeSync(Schema.fromJsonString(Machine));
const decodeProject = Schema.decodeSync(Schema.fromJsonString(ProjectSummary));
const encodeProject = Schema.encodeSync(Schema.fromJsonString(ProjectSummary));
const decodeThread = Schema.decodeSync(Schema.fromJsonString(ThreadSummary));
const encodeThread = Schema.encodeSync(Schema.fromJsonString(ThreadSummary));

const escapeLike = (s: string) => s.replace(/[\\%_]/gu, (c) => `\\${c}`);

const make = Effect.gen(function* () {
  const { db } = yield* HubDb.HubDb;

  const sql = {
    machineUpsert: db.prepare(
      "INSERT INTO machines (machine_id, data) VALUES (?, ?) ON CONFLICT (machine_id) DO UPDATE SET data = excluded.data",
    ),
    nodeKeyUpsert: db.prepare(
      "INSERT INTO node_keys (machine_id, pub_key) VALUES (?, ?) ON CONFLICT (machine_id) DO UPDATE SET pub_key = excluded.pub_key",
    ),
    machineGet: db.prepare("SELECT data FROM machines WHERE machine_id = ?"),
    machineList: db.prepare("SELECT data FROM machines ORDER BY machine_id"),
    machineDelete: db.prepare("DELETE FROM machines WHERE machine_id = ?"),
    projectUpsert: db.prepare(
      `INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (machine_id, project_id) DO UPDATE SET
         search = excluded.search, last_activity_at = excluded.last_activity_at, data = excluded.data`,
    ),
    projectList: db.prepare(
      `SELECT data FROM projects
       WHERE ($machine IS NULL OR machine_id = $machine) AND ($query IS NULL OR search LIKE $query ESCAPE '\\')
       ORDER BY last_activity_at DESC`,
    ),
    projectGet: db.prepare("SELECT data FROM projects WHERE machine_id = ? AND project_id = ?"),
    projectDelete: db.prepare("DELETE FROM projects WHERE machine_id = ? AND project_id = ?"),
    projectThreadsDelete: db.prepare("DELETE FROM threads WHERE machine_id = ? AND project_id = ?"),
    threadUpsert: db.prepare(
      `INSERT INTO threads (machine_id, thread_id, project_id, last_progress_at, last_sequence, last_run_id, last_run_status, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (machine_id, thread_id) DO UPDATE SET
         project_id = excluded.project_id, last_progress_at = excluded.last_progress_at,
         last_sequence = COALESCE(excluded.last_sequence, threads.last_sequence),
         last_run_id = COALESCE(excluded.last_run_id, threads.last_run_id),
         last_run_status = COALESCE(excluded.last_run_status, threads.last_run_status), data = excluded.data`,
    ),
    threadGet: db.prepare(
      "SELECT data, last_sequence, last_run_id, last_run_status FROM threads WHERE machine_id = ? AND thread_id = ?",
    ),
    threadsRunning: db.prepare("SELECT data FROM threads WHERE json_extract(data, '$.status') = 'running'"),
    threadsByProject: db.prepare(
      "SELECT data FROM threads WHERE machine_id = ? AND project_id = ? ORDER BY last_progress_at DESC LIMIT ?",
    ),
    cursorGet: db.prepare("SELECT seq FROM shell_cursors WHERE machine_id = ?"),
    cursorSet: db.prepare(
      "INSERT INTO shell_cursors (machine_id, seq) VALUES (?, ?) ON CONFLICT (machine_id) DO UPDATE SET seq = excluded.seq",
    ),
  };

  const getMachine = (machineId: MachineId) => {
    const row = sql.machineGet.get(machineId);
    return row ? decodeMachine(String(row.data)) : undefined;
  };

  return HubStore.of({
    machines: {
      upsert: ({ pubKey, ...machine }) =>
        Effect.sync(() =>
          HubDb.transaction(db, () => {
            sql.machineUpsert.run(machine.machineId, encodeMachine(machine));
            if (pubKey !== undefined) sql.nodeKeyUpsert.run(machine.machineId, pubKey);
          }),
        ),
      get: (machineId) => Effect.sync(() => getMachine(machineId)),
      list: () => Effect.sync(() => sql.machineList.all().map((row) => decodeMachine(String(row.data)))),
      setStatus: (machineId, status, at) =>
        Effect.sync(() =>
          HubDb.transaction(db, () => {
            const machine = getMachine(machineId);
            if (machine) sql.machineUpsert.run(machineId, encodeMachine({ ...machine, status, lastSeenAt: at }));
          }),
        ),
      remove: (machineId) => Effect.sync(() => void sql.machineDelete.run(machineId)),
    },
    projects: {
      upsertMany: (machineId, projects) =>
        Effect.sync(() =>
          HubDb.transaction(db, () => {
            for (const project of projects) {
              const row = { ...project, machineId };
              sql.projectUpsert.run(
                machineId,
                row.projectId,
                `${row.title}\n${row.workspaceRoot}`,
                row.lastActivityAt,
                encodeProject(row),
              );
            }
          }),
        ),
      list: (filter = {}) =>
        Effect.sync(() =>
          sql.projectList
            .all({
              machine: filter.machineId ?? null,
              query: filter.query ? `%${escapeLike(filter.query)}%` : null,
            })
            .map((row) => decodeProject(String(row.data))),
        ),
      get: (ref) =>
        Effect.sync(() => {
          const row = sql.projectGet.get(ref.machineId, ref.projectId);
          return row ? decodeProject(String(row.data)) : undefined;
        }),
      remove: (ref) =>
        Effect.sync(() =>
          HubDb.transaction(db, () => {
            sql.projectDelete.run(ref.machineId, ref.projectId);
            sql.projectThreadsDelete.run(ref.machineId, ref.projectId);
          }),
        ),
    },
    threads: {
      upsert: ({ lastSequence, lastRunId, lastRunStatus, ...thread }) =>
        Effect.sync(() => {
          sql.threadUpsert.run(
            thread.machineId,
            thread.threadId,
            thread.projectId,
            thread.lastProgressAt,
            lastSequence ?? null,
            lastRunId ?? null,
            lastRunStatus ?? null,
            encodeThread(thread),
          );
        }),
      get: (ref) =>
        Effect.sync(() => {
          const row = sql.threadGet.get(ref.machineId, ref.threadId);
          if (!row) return undefined;
          return {
            ...decodeThread(String(row.data)),
            ...(row.last_sequence === null ? {} : { lastSequence: Number(row.last_sequence) }),
            ...(row.last_run_id === null ? {} : { lastRunId: String(row.last_run_id) }),
            ...(row.last_run_status === null ? {} : { lastRunStatus: String(row.last_run_status) }),
          } satisfies StoredThread;
        }),
      listRunning: () => Effect.sync(() => sql.threadsRunning.all().map((row) => decodeThread(String(row.data)))),
      listByProject: (ref, limit) =>
        Effect.sync(() =>
          sql.threadsByProject.all(ref.machineId, ref.projectId, limit).map((row) => decodeThread(String(row.data))),
        ),
    },
    cursors: {
      get: (machineId) =>
        Effect.sync(() => {
          const row = sql.cursorGet.get(machineId);
          return row ? Number(row.seq) : undefined;
        }),
      set: (machineId, seq) =>
        Effect.sync(() => {
          sql.cursorSet.run(machineId, seq);
        }),
    },
  });
});

export const layer = Layer.effect(HubStore, make);
