import type { ProjectId, TaskId, WorkstreamId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import { REF } from "../tasks/testKit.ts";
import * as Incidents from "./Incidents.ts";

const layer = Incidents.layer.pipe(
  Layer.provideMerge(EventLog.layer),
  Layer.provideMerge(HubDb.layerMemory),
  Layer.provideMerge(TestClock.layer()),
);

const OTHER = { ...REF, projectId: "p2" as ProjectId };
const W1 = "W1" as WorkstreamId;

describe("Incidents", () => {
  it("numbers incidents, announces each one and lists them newest first by project, workstream and class", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const incidents = yield* Incidents.Incidents;
            const events = yield* EventLog.EventLog;
            const cursor = yield* events.head();

            const first = yield* incidents.record({ class: "false_claim", projectRef: REF, workstreamId: W1, evidence: ["C3: check 0 failed (exit 1)", "x".repeat(2500)] });
            expect(first).toMatchObject({ incidentId: "I1", class: "false_claim", at: "1970-01-01T00:00:00.000Z" });
            expect(first.evidence[1]).toHaveLength(2000);
            yield* incidents.record({ class: "polish_loop", projectRef: REF, workstreamId: "W2" as WorkstreamId, taskId: "T4" as TaskId, evidence: ["two clean reviews"] });
            yield* incidents.record({ class: "estimate_miss", projectRef: OTHER, evidence: ["3x"] });

            const announced = (yield* events.wait({ cursor, types: ["incident.recorded"], timeoutSec: 0 })).events;
            expect(announced.map((e) => e.data)).toEqual([
              { incidentId: "I1", class: "false_claim", workstreamId: "W1" },
              { incidentId: "I2", class: "polish_loop", workstreamId: "W2", taskId: "T4" },
              { incidentId: "I3", class: "estimate_miss" },
            ]);
            expect(announced[0]!.summary).toBe("I1 false_claim on W1: C3: check 0 failed (exit 1)");

            const ids = (filter: Incidents.IncidentFilter) => Effect.map(incidents.list(filter), (xs) => xs.map((i) => i.incidentId));
            expect(yield* ids({ limit: 10 })).toEqual(["I3", "I2", "I1"]);
            expect(yield* ids({ limit: 2 })).toEqual(["I3", "I2"]);
            expect(yield* ids({ projectRef: REF, limit: 10 })).toEqual(["I2", "I1"]);
            expect(yield* ids({ workstreamId: W1, limit: 10 })).toEqual(["I1"]);
            expect(yield* ids({ class: "estimate_miss", limit: 10 })).toEqual(["I3"]);
          }),
          layer,
        ),
      ),
    ));
});
