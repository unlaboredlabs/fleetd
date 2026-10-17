// When T3 deletes a project, the executor drops it from the hub's cache and emits project.removed. Nothing can run
// there any more, so the project's live work ends: open asks are withdrawn (they leave the inbox), live tasks are
// cancelled (their slots and leases go back), and open workstreams stop. Its lead reads as stopped (Leads.leadState).
//
// The reaction is keyed on the cache, not the event: live work whose project the cache no longer has is ended. That
// makes it idempotent, so the hub runs it once at start for every such project, and a stop between the event and
// the reaction loses nothing.
import type { ProjectRef, TaskState } from "@fleetd/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Asks } from "../ledger/Asks.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";
import { Tasks } from "../tasks/Tasks.ts";
import * as LeadRecords from "./LeadRecords.ts";

export const STOPPED_REASON = "its project was deleted in T3";
export const ASK_REASON = "project deleted";

const LIVE_TASKS: ReadonlyArray<TaskState> = ["queued", "running", "idle"];
const SCAN_LIMIT = 10_000;

const keyOf = (ref: ProjectRef) => `${ref.machineId}/${ref.projectId}`;

export const make = Effect.gen(function* () {
  const records = yield* LeadRecords.LeadRecords;
  const store = yield* HubStore.HubStore;
  const events = yield* EventLog.EventLog;
  const asks = yield* Asks;
  const tasks = yield* Tasks;

  /** Ends the project's live work if the cache no longer has the project; a no-op otherwise. */
  const reconcile = (ref: ProjectRef) =>
    Effect.gen(function* () {
      if ((yield* store.projects.get(ref)) !== undefined) return;
      for (const ask of yield* asks.list({ state: "open", projectRef: ref, limit: SCAN_LIMIT })) {
        yield* Effect.ignore(asks.withdraw(ask.askId, { reason: ASK_REASON }));
      }
      const caller = { projectRef: ref, by: "hub" };
      for (const state of LIVE_TASKS) {
        for (const task of yield* tasks.list({ ref, state, limit: SCAN_LIMIT })) {
          yield* Effect.ignore(tasks.cancel(caller, task.taskId, `Cancelled: ${STOPPED_REASON}.`));
        }
      }
      for (const w of yield* records.workstreams.list({ ref, open: true, limit: SCAN_LIMIT })) {
        const stored = yield* records.workstreams.get(w.workstreamId);
        if (stored === undefined) continue;
        const at = DateTime.formatIso(yield* DateTime.now);
        const headline = `Stopped: ${STOPPED_REASON}.`;
        yield* records.workstreams.put({ ...stored, workstream: { ...stored.workstream, state: "stopped", headline, headlineAt: at, updatedAt: at } });
        yield* events.append({
          at,
          type: "workstream.state",
          machineId: ref.machineId,
          projectId: ref.projectId,
          summary: `${w.workstreamId} is stopped: ${STOPPED_REASON}`,
          data: { workstreamId: w.workstreamId, state: "stopped", reason: STOPPED_REASON },
        });
      }
    });

  /** Every project with live work, as the records name them. */
  const projectsWithLiveWork = Effect.gen(function* () {
    const refs = new Map<string, ProjectRef>();
    const add = (ref: ProjectRef | undefined) => void (ref !== undefined && refs.set(keyOf(ref), ref));
    for (const ask of yield* asks.list({ state: "open", limit: SCAN_LIMIT })) add(ask.projectRef);
    for (const state of LIVE_TASKS) for (const task of yield* tasks.list({ state, limit: SCAN_LIMIT })) add(task.projectRef);
    for (const w of yield* records.workstreams.list({ open: true, limit: SCAN_LIMIT })) add(w.projectRef);
    return [...refs.values()];
  });

  return { reconcile, projectsWithLiveWork };
});

/** Catches up at start, then follows project.removed from there. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { reconcile, projectsWithLiveWork } = yield* make;
    const events = yield* EventLog.EventLog;
    let cursor = yield* events.head();
    for (const ref of yield* projectsWithLiveWork) yield* reconcile(ref);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const page = yield* events.wait({ cursor, types: ["project.removed"], timeoutSec: 3600 });
          cursor = page.cursor;
          for (const event of page.events) {
            if (event.machineId !== undefined && event.projectId !== undefined) {
              yield* reconcile({ machineId: event.machineId, projectId: event.projectId });
            }
          }
        }),
      ),
    );
  }),
);
