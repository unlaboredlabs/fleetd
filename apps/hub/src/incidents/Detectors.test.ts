import type { DecisionKey, HubEvent, Incident, ThreadId, WorkstreamId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { REF } from "../leads/testKit.ts";
import { Asks } from "../ledger/Asks.ts";
import { Decisions } from "../ledger/Decisions.ts";
import * as Inbox from "../ledger/Inbox.ts";
import * as Ledger from "../ledger/Ledger.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as TaskRecords from "../tasks/TaskRecords.ts";
import * as Detectors from "./Detectors.ts";

const layer = Detectors.layer.pipe(
  Layer.provideMerge(Layer.merge(Ledger.layer, TaskRecords.layer)),
  Layer.provideMerge(Inbox.layerAnswerSinkNoop),
  Layer.provideMerge(EventLog.layer),
  Layer.provideMerge(HubDb.layerMemory),
  Layer.provideMerge(TestClock.layer()),
);

const run = <A, E>(body: Effect.Effect<A, E, Layer.Success<typeof layer>>) => Effect.runPromise(Effect.scoped(Effect.provide(body, layer)));

const W1 = "W1" as WorkstreamId;
const W2 = "W2" as WorkstreamId;
const key = "api.health.path" as DecisionKey;
const lead = { source: "lead", by: "lead:lab-a/p1" } as const;
const human = { source: "human", by: "human:phone" } as const;

/** The next `n` incidents recorded after `cursor`; the detector appends them as it reads the events before. */
const nextIncidents = (cursor: number, n: number) =>
  Effect.gen(function* () {
    const log = yield* EventLog.EventLog;
    const found: Array<HubEvent> = [];
    let at = cursor;
    while (found.length < n) {
      const page = yield* log.wait({ cursor: at, types: ["incident.recorded"], timeoutSec: 60 });
      found.push(...page.events);
      at = page.cursor;
    }
    return found.map((e) => e.data as Pick<Incident, "incidentId" | "class" | "workstreamId" | "taskId">);
  });

describe("incident detectors", () => {
  it("records stalls (with their task), out-of-area writes, and nothing for other failures", () =>
    run(
      Effect.gen(function* () {
        const log = yield* EventLog.EventLog;
        const task = yield* (yield* TaskRecords.TaskRecords).create({
          projectRef: REF,
          workstreamId: W1,
          title: "add file",
          kind: "write",
          prompt: "create docs/x.md",
          areas: ["docs"],
          model: "claude-haiku-5-5",
          effort: "low",
          state: "running",
          attempt: 1,
          threadRef: { machineId: REF.machineId, threadId: "t-task" as ThreadId },
          createdAt: "1970-01-01T00:00:00.000Z",
        } as never);
        const cursor = yield* log.head();
        const at = "1970-01-01T00:00:00.000Z";
        const where = { machineId: REF.machineId, projectId: REF.projectId };
        yield* log.append({ at, type: "thread.stalled", ...where, threadId: "t-task" as ThreadId, summary: '"add file" on lab-a stalled: no progress for 12 min', data: { status: "running" } });
        yield* log.append({ at, type: "thread.failed", ...where, threadId: "t-lead" as ThreadId, summary: "failed", data: { reason: "t3" } });
        yield* log.append({ at, type: "thread.failed", ...where, threadId: "t-lead" as ThreadId, summary: "failed: stalled again after a nudge", data: { reason: "stalled" } });
        yield* log.append({ at, type: "task.out_of_area", ...where, summary: `${task.taskId} changed 1 file outside docs: notes.txt`, data: { taskId: task.taskId, workstreamId: W1, paths: ["notes.txt"] } });
        expect(yield* nextIncidents(cursor, 3)).toEqual([
          { incidentId: "I1", class: "stall", workstreamId: "W1", taskId: task.taskId },
          { incidentId: "I2", class: "stall" },
          { incidentId: "I3", class: "out_of_area", workstreamId: "W1", taskId: task.taskId },
        ]);
      }),
    ));

  it("records an override when a human replaces a lead's decision with another value, and a re-ask for an answer to a decided key", () =>
    run(
      Effect.gen(function* () {
        const decisions = yield* Decisions;
        const log = yield* EventLog.EventLog;
        const cursor = yield* log.head();
        yield* decisions.record({ key, scope: { kind: "workstream", workstreamId: W1 }, value: "/health", projectRef: REF }, lead);
        // Restating the lead's value is no override.
        yield* decisions.record({ key, scope: { kind: "project", projectRef: REF }, value: "/health" }, human);
        yield* decisions.record({ key, scope: { kind: "project", projectRef: REF }, value: "/healthz" }, human);
        const [override] = yield* nextIncidents(cursor, 1);
        expect(override).toEqual({ incidentId: "I1", class: "override", workstreamId: "W1" });

        // W2's lead asks the human about a key W1's lead already decided; the answer is a re-ask.
        const engine = "db.engine" as DecisionKey;
        yield* decisions.record({ key: engine, scope: { kind: "workstream", workstreamId: W1 }, value: "sqlite", projectRef: REF }, lead);
        const asked = yield* (yield* Asks).create(
          { projectRef: REF, workstreamId: W2, kind: "decide", key: engine, class: "product", text: "Which database?", recommendation: "sqlite", blocks: "nothing", proceededOnRec: false },
          "lead:lab-a/p1",
        );
        expect(asked.state).toBe("open");
        const before = yield* log.head();
        yield* (yield* Inbox.Inbox).reply({ raw: "1 go" }, human);
        expect(yield* nextIncidents(before, 1)).toEqual([{ incidentId: "I2", class: "re_ask", workstreamId: "W2" }]);
        const [incident] = (yield* log.wait({ cursor: before, types: ["incident.recorded"], timeoutSec: 0 })).events;
        expect(incident!.summary).toBe('I2 re_ask on W2: A1 asked the human about db.engine, already decided by D4 (lead) = "sqlite"; answered D5 = "sqlite"');
      }),
    ));
});
