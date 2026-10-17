import { AreaName, MachineId, ProjectId, type ProjectRef, TaskId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { allEvents, NOW } from "../queue/testKit.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import { Leases, layer } from "./Leases.ts";

const A: ProjectRef = { machineId: MachineId.make("lab-a"), projectId: ProjectId.make("pa") };
const B: ProjectRef = { machineId: MachineId.make("lab-a"), projectId: ProjectId.make("pb") };
const areas = (...names: Array<string>) => names.map((n) => AreaName.make(n));
const T = (n: number) => TaskId.make(`T${n}`);

const run = <A, E>(effect: Effect.Effect<A, E, Leases | EventLog.EventLog>) =>
  Effect.runPromise(
    Effect.andThen(TestClock.setTime(NOW), effect).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provideMerge(EventLog.layer),
          Layer.provideMerge(HubDb.layerMemory),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  );

const take = (projectRef: ProjectRef, n: number, ...names: Array<string>) =>
  Effect.gen(function* () {
    return yield* (yield* Leases).acquire({ projectRef, taskId: T(n), areas: areas(...names) });
  });
const held = (n: number) =>
  Effect.gen(function* () {
    return (yield* (yield* Leases).list({ taskId: T(n) })).map((l) => l.area);
  });

describe("Leases", () => {
  it("takes all of a task's areas or none, so crossing requests cannot deadlock", () =>
    run(
      Effect.gen(function* () {
        const leases = yield* Leases;
        expect(yield* take(A, 1, "docs", "hub")).toEqual({ granted: true });
        expect(yield* held(1)).toEqual(["docs", "hub"]);
        // T2 wants the same areas in the other order, plus a free one: it gets nothing, not even "web".
        expect(yield* take(A, 2, "hub", "web", "docs")).toEqual({ granted: false, reason: "lease: hub held by T1, docs held by T1" });
        expect(yield* held(2)).toEqual([]);
        // So a third task can still take the free area.
        expect(yield* take(A, 3, "web")).toEqual({ granted: true });
        expect(yield* take(A, 2, "hub", "web", "docs")).toEqual({
          granted: false,
          reason: "lease: hub held by T1, web held by T3, docs held by T1",
        });
        expect((yield* leases.release(T(1))).map((l) => l.area)).toEqual(["docs", "hub"]);
        expect(yield* take(A, 2, "hub", "web", "docs")).toEqual({ granted: false, reason: "lease: web held by T3" });
        yield* leases.release(T(3));
        expect(yield* take(A, 2, "hub", "web", "docs")).toEqual({ granted: true });
        expect(yield* held(2)).toEqual(["docs", "hub", "web"]);
      }),
    ));

  it("is exclusive per project, idempotent for the holder, and lists oldest first", () =>
    run(
      Effect.gen(function* () {
        const leases = yield* Leases;
        yield* take(A, 1, "docs");
        yield* TestClock.adjust("1 minute");
        expect(yield* take(B, 2, "docs")).toEqual({ granted: true });
        // Asking again, or for a superset, keeps what T1 has.
        expect(yield* take(A, 1, "docs")).toEqual({ granted: true });
        expect(yield* take(A, 1, "docs", "hub")).toEqual({ granted: true });
        expect((yield* leases.list()).map((l) => `${l.projectRef.projectId}:${l.area}:${l.taskId}:${l.since}`)).toEqual([
          "pa:docs:T1:2026-10-17T10:00:00.000Z",
          "pb:docs:T2:2026-10-17T10:01:00.000Z",
          "pa:hub:T1:2026-10-17T10:01:00.000Z",
        ]);
        expect((yield* leases.list({ projectRef: B })).map((l) => l.taskId)).toEqual(["T2"]);
        expect(yield* leases.release(T(9))).toEqual([]);
      }),
    ));

  it("flags a lease held over 4 h once, and keeps it", () =>
    run(
      Effect.gen(function* () {
        const leases = yield* Leases;
        yield* take(A, 1, "docs");
        yield* TestClock.adjust("4 hours");
        expect(yield* leases.flagStale()).toBe(0);
        yield* TestClock.adjust("1 minute");
        expect(yield* leases.flagStale()).toBe(1);
        expect(yield* leases.flagStale()).toBe(0);
        const events = (yield* allEvents).filter((e) => e.type === "lease.stale");
        expect(events).toMatchObject([
          {
            machineId: "lab-a",
            projectId: "pa",
            summary: "Lease on docs in pa held by T1 for 4 h; still held",
            data: { taskId: "T1", area: "docs", since: "2026-10-17T10:00:00.000Z" },
          },
        ]);
        expect(yield* leases.list()).toHaveLength(1);
      }),
    ));
});
