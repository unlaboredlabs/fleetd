// Area leases: one writer per area within a project, from spawn until the task ends. A task takes all of its
// areas at once or none of them, so no task ever holds some areas while waiting for others, and two tasks can
// never deadlock on each other's areas. The hub never releases a lease on its own; one held past 4 h is flagged.
import { AreaName, Lease, MachineId, ProjectId, type ProjectRef, TaskId } from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Grant } from "../slots/Slots.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as Sweep from "../sweep/Sweep.ts";

export const STALE_AFTER_MS = 4 * 60 * 60_000;

/** "lease: docs held by T1, hub held by T2", trimmed to fit `Task.queuedReason`. */
const conflictReason = (conflicts: ReadonlyArray<{ readonly area: string; readonly heldBy: string }>) => {
  const text = `lease: ${conflicts.map((c) => `${c.area} held by ${c.heldBy}`).join(", ")}`;
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
};

export class Leases extends Context.Service<
  Leases,
  {
    /**
     * Takes every area in `areas` for `taskId`, or none: if another task holds any of them, the reason names every
     * conflict. Areas the task already holds count as granted.
     */
    readonly acquire: (request: {
      readonly projectRef: ProjectRef;
      readonly taskId: TaskId;
      readonly areas: ReadonlyArray<AreaName>;
    }) => Effect.Effect<Grant>;
    /** Drops every lease the task holds and returns them. */
    readonly release: (taskId: TaskId) => Effect.Effect<ReadonlyArray<Lease>>;
    /** Oldest first, for the digest. */
    readonly list: (filter?: { readonly projectRef?: ProjectRef; readonly taskId?: TaskId }) => Effect.Effect<ReadonlyArray<Lease>>;
    /** Emits `lease.stale` once for each lease held over 4 h. Returns how many it flagged. */
    readonly flagStale: () => Effect.Effect<number>;
  }
>()("fleetd/leases/Leases") {}

/** True when `lease` has been held for over 4 h at `nowMs`. */
export const isStale = (lease: Lease, nowMs: number) => nowMs - Date.parse(lease.since) > STALE_AFTER_MS;

const make = Effect.gen(function* () {
  const { db } = yield* HubDb.HubDb;
  const events = yield* EventLog.EventLog;

  const sql = {
    inProject: db.prepare("SELECT * FROM leases WHERE machine_id = ? AND project_id = ?"),
    insert: db.prepare("INSERT INTO leases (machine_id, project_id, area, task_id, since) VALUES (?, ?, ?, ?, ?)"),
    byTask: db.prepare("SELECT * FROM leases WHERE task_id = ?"),
    deleteByTask: db.prepare("DELETE FROM leases WHERE task_id = ?"),
    list: db.prepare(
      `SELECT * FROM leases WHERE ($machine IS NULL OR (machine_id = $machine AND project_id = $project))
         AND ($task IS NULL OR task_id = $task) ORDER BY since, area`,
    ),
    unflagged: db.prepare("SELECT * FROM leases WHERE stale_flagged = 0 AND since < ? ORDER BY since"),
    flag: db.prepare("UPDATE leases SET stale_flagged = 1 WHERE machine_id = ? AND project_id = ? AND area = ?"),
  };

  const toLease = (row: Record<string, unknown>): Lease => ({
    projectRef: { machineId: MachineId.make(String(row.machine_id)), projectId: ProjectId.make(String(row.project_id)) },
    area: AreaName.make(String(row.area)),
    taskId: TaskId.make(String(row.task_id)),
    since: String(row.since),
  });

  return Leases.of({
    acquire: ({ projectRef, taskId, areas }) =>
      Effect.gen(function* () {
        const since = DateTime.formatIso(yield* DateTime.now);
        return HubDb.transaction(db, (): Grant => {
          const held = new Map(sql.inProject.all(projectRef.machineId, projectRef.projectId).map((row) => [String(row.area), String(row.task_id)]));
          const conflicts = areas.flatMap((area) => {
            const heldBy = held.get(area);
            return heldBy !== undefined && heldBy !== taskId ? [{ area, heldBy }] : [];
          });
          if (conflicts.length > 0) return { granted: false, reason: conflictReason(conflicts) };
          for (const area of areas) {
            if (!held.has(area)) sql.insert.run(projectRef.machineId, projectRef.projectId, area, taskId, since);
          }
          return { granted: true };
        });
      }),
    release: (taskId) =>
      Effect.sync(() =>
        HubDb.transaction(db, () => {
          const leases = sql.byTask.all(taskId).map(toLease);
          sql.deleteByTask.run(taskId);
          return leases;
        }),
      ),
    list: (filter = {}) =>
      Effect.sync(() =>
        sql.list
          .all({
            machine: filter.projectRef?.machineId ?? null,
            project: filter.projectRef?.projectId ?? null,
            task: filter.taskId ?? null,
          })
          .map(toLease),
      ),
    flagStale: () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const stale = sql.unflagged.all(new Date(now - STALE_AFTER_MS).toISOString()).map(toLease);
        for (const lease of stale) {
          const hours = Math.floor((now - Date.parse(lease.since)) / 3_600_000);
          yield* events.append({
            at: new Date(now).toISOString(),
            type: "lease.stale",
            machineId: lease.projectRef.machineId,
            projectId: lease.projectRef.projectId,
            summary: `Lease on ${lease.area} in ${lease.projectRef.projectId} held by ${lease.taskId} for ${hours} h; still held`,
            data: { taskId: lease.taskId, area: lease.area, since: lease.since },
          });
          sql.flag.run(lease.projectRef.machineId, lease.projectRef.projectId, lease.area);
        }
        return stale.length;
      }),
  });
});

/** Needs HubDb and EventLog. */
export const layer = Layer.effect(Leases, make);

/** Adds the stale-lease check to the 5-min sweep. */
export const layerSweep = Layer.effectDiscard(
  Effect.gen(function* () {
    const leases = yield* Leases;
    yield* (yield* Sweep.Sweep).register({ name: "stale leases", run: leases.flagStale() });
  }),
);
