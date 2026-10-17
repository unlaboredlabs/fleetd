// A project T3 deleted: its asks leave the inbox, its tasks give back their slots and leases, its workstreams stop,
// and a hub stopped before it reacted catches up on start.
import type { DecisionKey, WorkstreamId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { Asks } from "../ledger/Asks.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";
import * as Tasks from "../tasks/Tasks.ts";
import { LEAD, leaseOwners, makeKit, nextEvent, REF, runKit, slotsUsed } from "../tasks/testKit.ts";
import * as Leads from "./Leads.ts";
import * as ProjectRemovals from "./ProjectRemovals.ts";
import * as Workstreams from "./Workstreams.ts";

const spawn = (workstreamId: WorkstreamId) =>
  Effect.flatMap(Tasks.Tasks, (tasks) =>
    tasks.spawn(LEAD, { workstreamId, title: "add file", kind: "write", prompt: "create docs/x.md", areas: ["docs"], serves: "done:0" } as unknown as Tasks.SpawnInput),
  );

const fileAsk = Effect.flatMap(Asks, (asks) =>
  asks.create(
    { projectRef: REF, kind: "decide", key: "api.health.path" as DecisionKey, class: "product", text: "Which path?", recommendation: "/health", blocks: "nothing", proceededOnRec: true },
    LEAD.by,
  ),
);

/** What the executor does on a project.removed shell item, or a snapshot that no longer lists the project. */
const deleteInT3 = Effect.gen(function* () {
  const cursor = yield* (yield* EventLog.EventLog).head();
  yield* (yield* HubStore.HubStore).projects.remove(REF);
  yield* (yield* EventLog.EventLog).append({
    at: "1970-01-01T00:00:00.000Z",
    type: "project.removed",
    machineId: REF.machineId,
    projectId: REF.projectId,
    summary: 'Project "Demo" on lab-a was deleted in T3',
  });
  return cursor;
});

describe("project removals", () => {
  it("cancels the project's tasks, giving back their slots and leases, and stops its workstreams", async () => {
    const kit = makeKit({ cap: 1 });
    await runKit(
      kit,
      Effect.scoped(Effect.gen(function* () {
        const ws = yield* kit.setup;
        yield* Layer.build(ProjectRemovals.layer);
        const running = yield* spawn(ws);
        const queued = yield* spawn(ws);
        expect([running.state, queued.state]).toEqual(["running", "queued"]);
        expect(yield* slotsUsed).toBe(1);

        const cursor = yield* deleteInT3;
        yield* nextEvent(cursor, "workstream.state");
        const tasks = yield* Tasks.Tasks;
        for (const task of [running, queued]) {
          expect(yield* tasks.get(task.taskId)).toMatchObject({ state: "cancelled", result: { status: "cancelled", tail: "Cancelled: its project was deleted in T3." } });
        }
        expect(yield* slotsUsed).toBe(0);
        expect(yield* leaseOwners).toEqual({});
        expect(yield* (yield* Workstreams.Workstreams).get(ws)).toMatchObject({ state: "stopped", headline: "Stopped: its project was deleted in T3." });
        expect((yield* (yield* Leads.Leads).get(REF))?.state).toBe("stopped");
      })),
    );
  });

  it("withdraws the project's open asks with the reason, so they leave the inbox", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.scoped(Effect.gen(function* () {
        yield* kit.setup;
        yield* Layer.build(ProjectRemovals.layer);
        const { ask } = yield* fileAsk;
        const cursor = yield* deleteInT3;
        yield* nextEvent(cursor, "workstream.state");
        const asks = yield* Asks;
        expect(yield* asks.get(ask.askId)).toMatchObject({ state: "withdrawn", answer: { value: "project deleted", by: "hub" } });
        expect(yield* asks.list({ state: "open" })).toEqual([]);
      })),
    );
  });

  it("catches up on start when the hub stopped between the event and the reaction", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.scoped(Effect.gen(function* () {
        const ws = yield* kit.setup;
        const task = yield* spawn(ws);
        const { ask } = yield* fileAsk;
        // The project goes while nothing follows the event log, as if the hub stopped right after the executor.
        yield* deleteInT3;

        yield* Layer.build(ProjectRemovals.layer);
        expect((yield* (yield* Tasks.Tasks).get(task.taskId))?.state).toBe("cancelled");
        expect((yield* (yield* Asks).get(ask.askId))?.state).toBe("withdrawn");
        expect((yield* (yield* Workstreams.Workstreams).get(ws))?.state).toBe("stopped");
        expect(yield* slotsUsed).toBe(0);
      })),
    );
  });
});
