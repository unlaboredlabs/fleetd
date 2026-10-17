// When T3 deletes a project, the executor drops it from the hub's cache and emits project.removed. This stops the
// project's open workstreams, since nothing can run there any more; its lead reads as stopped (Leads.leadState).
import type { Workstream } from "@fleetd/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EventLog from "../store/EventLog.ts";
import * as LeadRecords from "./LeadRecords.ts";

export const STOPPED_REASON = "its project was deleted in T3";

/** Follows the event log from the hub's start; the executor emits project.removed only once machines attach. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const records = yield* LeadRecords.LeadRecords;
    const events = yield* EventLog.EventLog;

    const stop = (w: Workstream) =>
      Effect.gen(function* () {
        const stored = yield* records.workstreams.get(w.workstreamId);
        if (stored === undefined) return;
        const at = DateTime.formatIso(yield* DateTime.now);
        const headline = `Stopped: ${STOPPED_REASON}.`;
        yield* records.workstreams.put({ ...stored, workstream: { ...stored.workstream, state: "stopped", headline, headlineAt: at, updatedAt: at } });
        yield* events.append({
          at,
          type: "workstream.state",
          machineId: w.projectRef.machineId,
          projectId: w.projectRef.projectId,
          summary: `${w.workstreamId} is stopped: ${STOPPED_REASON}`,
          data: { workstreamId: w.workstreamId, state: "stopped", reason: STOPPED_REASON },
        });
      });

    let cursor = yield* events.head();
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const page = yield* events.wait({ cursor, types: ["project.removed"], timeoutSec: 3600 });
          cursor = page.cursor;
          for (const event of page.events) {
            if (event.machineId === undefined || event.projectId === undefined) continue;
            const ref = { machineId: event.machineId, projectId: event.projectId };
            for (const w of yield* records.workstreams.list({ ref, open: true, limit: 1000 })) yield* stop(w);
          }
        }),
      ),
    );
  }),
);
