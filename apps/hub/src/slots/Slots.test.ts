import { type HubEventType, MachineId, ProjectId, type ProjectRef, ThreadId } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as LeadRecords from "../leads/LeadRecords.ts";
import { settle } from "../queue/testKit.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as HubStore from "../store/HubStore.ts";
import { blocker, leadHolder, reservedBand, type SlotPriority, type SlotRequest, Slots, type SlotsOptions } from "./Slots.ts";
import * as SlotsModule from "./Slots.ts";

const project = (projectId: string, machineId = "lab-a"): ProjectRef => ({
  machineId: MachineId.make(machineId),
  projectId: ProjectId.make(projectId),
});
const A = project("pa");
const B = project("pb");
const AT = "2026-10-17T10:00:00.000Z";

type Base = HubDb.HubDb | HubStore.HubStore | EventLog.EventLog | LeadRecords.LeadRecords;

const run = <A, E>(effect: Effect.Effect<A, E, Base | Scope.Scope>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(HubStore.layer, EventLog.layer, LeadRecords.layer).pipe(
          Layer.provideMerge(HubDb.layerMemory),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  );

/**
 * One hub process's slot board; `stop` is the hub going down. Like the tasks area, its release listener records
 * which holders have a slot each time it runs, so `grants` lists them in the order they got one.
 */
const startSlots = (options: SlotsOptions = {}) =>
  Effect.gen(function* () {
    const { db } = yield* HubDb.HubDb;
    const scope = yield* Scope.make();
    const slots = Context.get(yield* Layer.buildWithScope(SlotsModule.layer(options), scope), Slots);
    const grants: Array<string> = [];
    const seen = new Set(held(db));
    let calls = 0;
    yield* slots.onRelease(
      Effect.sync(() => {
        calls++;
        for (const holder of held(db)) if (!seen.has(holder)) grants.push(holder);
        for (const holder of held(db)) seen.add(holder);
      }),
    );
    // Holders granted by `acquire` itself are not news to the listener.
    const acquire = (request: SlotRequest) =>
      Effect.tap(slots.acquire(request), (g) => Effect.sync(() => void (g.granted && seen.add(request.holder))));
    return { slots: { ...slots, acquire }, grants, calls: () => calls, stop: Scope.close(scope, Exit.void) };
  });

const held = (db: HubDb.HubDb["Service"]["db"]) =>
  db.prepare("SELECT holder FROM slot_claims WHERE state = 'held' ORDER BY order_n").all().map((row) => String(row.holder));

const req = (holder: string, projectRef: ProjectRef = A, priority: SlotPriority = "work") => ({ holder, projectRef, priority });

const threadEvent = (type: HubEventType, threadId: string, machineId = "lab-a") =>
  Effect.gen(function* () {
    yield* (yield* EventLog.EventLog).append({
      at: AT,
      type,
      machineId: MachineId.make(machineId),
      threadId: ThreadId.make(threadId),
      summary: `${threadId} ${type}`,
    });
    yield* settle;
  });

describe("reserved band", () => {
  it("is min(4, floor(10 % of cap)) and never the whole cap", () => {
    expect([1, 2, 9, 10, 19, 20, 40, 41, 1000].map(reservedBand)).toEqual([0, 0, 0, 1, 1, 2, 4, 4, 4]);
    for (let cap = 1; cap <= 1000; cap++) expect(reservedBand(cap)).toBeLessThan(cap);
  });

  it("keeps the band for leads and lets only leads pass a full project share", () => {
    const board = { cap: 10, used: 9, projectUsed: 0, share: 10 };
    expect(blocker(board, "work")).toBe("slots: 9/10 in use (1 reserved for lead turns)");
    expect(blocker(board, "lead")).toBeUndefined();
    expect(blocker({ ...board, used: 10 }, "lead")).toBe("slots: 10/10 in use");
    expect(blocker({ cap: 2, used: 2, projectUsed: 0, share: 2 }, "review")).toBe("slots: 2/2 in use");
    expect(blocker({ cap: 40, used: 3, projectUsed: 3, share: 3 }, "work")).toBe("slots: project share 3/3 in use");
    expect(blocker({ cap: 40, used: 3, projectUsed: 3, share: 3 }, "lead")).toBeUndefined();
  });
});

describe("Slots", () => {
  it("queues past the cap and grants the next request on release", () =>
    run(
      Effect.gen(function* () {
        const { slots, grants, calls } = yield* startSlots({ defaultCap: 2 });
        expect(yield* slots.acquire(req("T1"))).toEqual({ granted: true });
        expect(yield* slots.acquire(req("T2"))).toEqual({ granted: true });
        expect(yield* slots.acquire(req("T3"))).toEqual({ granted: false, reason: "slots: 2/2 in use" });
        expect(yield* slots.acquire(req("T1"))).toEqual({ granted: true });
        expect(yield* slots.state()).toMatchObject({ cap: 2, used: 2, queued: 1, reservedBand: 0 });
        yield* slots.release("T1");
        expect(grants).toEqual(["T3"]);
        expect(yield* slots.state()).toMatchObject({ used: 2, queued: 0 });
        // Releasing a queued request just drops it.
        yield* slots.acquire(req("T4"));
        yield* slots.release("T4");
        yield* slots.release("T2");
        expect(grants).toEqual(["T3"]);
        expect(yield* slots.state()).toMatchObject({ used: 1, queued: 0 });
        // The listener ran on registering and after each freed slot, but not for the dropped queued request.
        expect(calls()).toBe(3);
      }),
    ));

  it("serves leads, then reviews, then work, first come first served within each", () =>
    run(
      Effect.gen(function* () {
        const { slots, grants } = yield* startSlots({ defaultCap: 1 });
        yield* slots.acquire(req("T1"));
        yield* slots.acquire(req("T2"));
        yield* slots.acquire(req("T3"));
        yield* slots.acquire(req("R1", A, "review"));
        yield* slots.acquire(req("R2", A, "review"));
        yield* slots.acquire(req(leadHolder(A), A, "lead"));
        for (const holder of ["T1", leadHolder(A), "R1", "R2", "T2"]) yield* slots.release(holder);
        expect(grants).toEqual([leadHolder(A), "R1", "R2", "T2", "T3"]);
      }),
    ));

  it("keeps the reserved band free for lead turns", () =>
    run(
      Effect.gen(function* () {
        const { slots } = yield* startSlots({ defaultCap: 10 });
        for (let n = 1; n <= 9; n++) expect(yield* slots.acquire(req(`T${n}`))).toEqual({ granted: true });
        expect(yield* slots.acquire(req("T10"))).toEqual({
          granted: false,
          reason: "slots: 9/10 in use (1 reserved for lead turns)",
        });
        expect(yield* slots.acquire(req(leadHolder(B), B, "lead"))).toEqual({ granted: true });
        expect(yield* slots.acquire(req(leadHolder(A), A, "lead"))).toEqual({ granted: false, reason: "slots: 10/10 in use" });
      }),
    ));

  it("holds a project to its share without blocking other projects behind it", () =>
    run(
      Effect.gen(function* () {
        const { slots, grants } = yield* startSlots({ defaultCap: 5 });
        yield* slots.setCap({ share: { projectRef: A, share: 1 } });
        expect(yield* slots.acquire(req("T1", A))).toEqual({ granted: true });
        expect(yield* slots.acquire(req("T2", A))).toEqual({ granted: false, reason: "slots: project share 1/1 in use" });
        expect(yield* slots.acquire(req("T3", B))).toEqual({ granted: true });
        expect((yield* slots.state()).perProject).toEqual([
          { projectRef: A, share: 1, used: 1 },
          { projectRef: B, share: 5, used: 1 },
        ]);
        yield* slots.release("T1");
        expect(grants).toEqual(["T2"]);
      }),
    ));

  it("applies cap changes at runtime and keeps them across a restart", () =>
    run(
      Effect.gen(function* () {
        const first = yield* startSlots({ defaultCap: 1 });
        yield* first.slots.acquire(req("T1"));
        yield* first.slots.acquire(req("T2"));
        yield* first.slots.acquire(req("T3"));
        const raised = yield* first.slots.setCap({ cap: 2 });
        expect(first.grants).toEqual(["T2"]);
        expect(raised).toMatchObject({ cap: 2, used: 2, queued: 1 });
        // Lowering the cap revokes nothing; it only stops new grants.
        expect(yield* first.slots.setCap({ cap: 1 })).toMatchObject({ cap: 1, used: 2, queued: 1 });
        yield* first.slots.release("T1");
        expect(first.grants).toEqual(["T2"]);
        yield* first.stop;

        const second = yield* startSlots({ defaultCap: 40 });
        expect(yield* second.slots.state()).toMatchObject({ cap: 1, used: 1, queued: 1 });
        yield* second.slots.release("T2");
        expect(second.grants).toEqual(["T3"]);
      }),
    ));

  it("hands grants due since startup to the first listener", () =>
    run(
      Effect.gen(function* () {
        const first = yield* startSlots({ defaultCap: 1 });
        yield* first.slots.acquire(req("T1"));
        yield* first.slots.acquire(req("T2"));
        yield* first.stop;
        // While the hub was down, T1's holder went away; the restarted board grants T2 to its first listener.
        const { db } = yield* HubDb.HubDb;
        db.prepare("DELETE FROM slot_claims WHERE holder = 'T1'").run();
        const second = yield* startSlots({ defaultCap: 1 });
        expect(second.grants).toEqual(["T2"]);
      }),
    ));

  it("holds a slot only while the bound thread runs, and re-takes it when the thread runs again", () =>
    run(
      Effect.gen(function* () {
        const { slots, grants } = yield* startSlots({ defaultCap: 1 });
        yield* slots.acquire(req("T1"));
        yield* slots.bind("T1", { machineId: A.machineId, threadId: ThreadId.make("t1") });
        yield* slots.acquire(req("T2"));
        yield* threadEvent("thread.started", "t1");
        expect(yield* slots.state()).toMatchObject({ used: 1, queued: 1 });
        // A stall is not a stop.
        yield* threadEvent("thread.stalled", "t1");
        expect(grants).toEqual([]);
        yield* threadEvent("thread.completed", "t1");
        expect(grants).toEqual(["T2"]);
        // A follow-up message ran T1 again outside the board: it counts, even past the cap.
        yield* threadEvent("thread.started", "t1");
        expect(yield* slots.state()).toMatchObject({ cap: 1, used: 2 });
        // Asking again for a running holder is a no-op grant.
        expect(yield* slots.acquire(req("T1"))).toEqual({ granted: true });
        yield* threadEvent("thread.waiting", "t1");
        expect(yield* slots.state()).toMatchObject({ used: 1 });
        // An idle holder asking again queues behind the others.
        yield* slots.acquire(req("T3"));
        expect(yield* slots.acquire(req("T1"))).toEqual({ granted: false, reason: "slots: 1/1 in use" });
        yield* slots.release("T2");
        expect(grants).toEqual(["T2", "T3"]);
      }),
    ));

  it("counts running lead threads, including after a lead restart onto a new thread", () =>
    run(
      Effect.gen(function* () {
        const records = yield* LeadRecords.LeadRecords;
        const lead = { projectRef: A, threadId: ThreadId.make("lead1"), startedAt: AT, sessionGeneration: 0 };
        yield* records.leads.put(lead);
        const { slots, grants } = yield* startSlots({ defaultCap: 2 });
        yield* threadEvent("thread.started", "lead1");
        yield* threadEvent("thread.started", "someone-elses");
        expect(yield* slots.state()).toMatchObject({ used: 1, perProject: [{ projectRef: A, used: 1 }] });
        yield* slots.acquire(req("T1"));
        // Band is 0 at cap 2; the lead holds one slot, T1 the other.
        expect(yield* slots.acquire(req("T2"))).toEqual({ granted: false, reason: "slots: 2/2 in use" });
        yield* threadEvent("thread.completed", "lead1");
        expect(grants).toEqual(["T2"]);
        yield* records.leads.put({ ...lead, threadId: ThreadId.make("lead2"), sessionGeneration: 1 });
        yield* threadEvent("thread.started", "lead2");
        expect(yield* slots.state()).toMatchObject({ used: 3 });
        // The old lead thread is no longer the lead's.
        yield* threadEvent("thread.completed", "lead1");
        expect(yield* slots.state()).toMatchObject({ used: 3 });
      }),
    ));

  it("rebuilds held slots from the stored thread status on restart", () =>
    run(
      Effect.gen(function* () {
        const store = yield* HubStore.HubStore;
        const records = yield* LeadRecords.LeadRecords;
        const thread = (threadId: string, status: "running" | "idle") =>
          store.threads.upsert({
            machineId: A.machineId,
            threadId: ThreadId.make(threadId),
            projectId: A.projectId,
            title: threadId,
            status,
            headline: "",
            latestMessageTail: "",
            lastProgressAt: AT,
            stale: false,
            asOf: AT,
          });
        const first = yield* startSlots({ defaultCap: 3 });
        yield* first.slots.acquire(req("T1"));
        yield* first.slots.bind("T1", { machineId: A.machineId, threadId: ThreadId.make("t1") });
        yield* first.slots.acquire(req("T2"));
        yield* first.slots.bind("T2", { machineId: A.machineId, threadId: ThreadId.make("t2") });
        yield* first.slots.acquire(req("T3"));
        yield* first.stop;
        // While the hub was down: t1 finished, t2 still runs, and the lead started a turn.
        yield* thread("t1", "idle");
        yield* thread("t2", "running");
        yield* thread("lead1", "running");
        yield* records.leads.put({ projectRef: A, threadId: ThreadId.make("lead1"), startedAt: AT, sessionGeneration: 0 });
        const second = yield* startSlots({ defaultCap: 3 });
        // t2, the lead and T3's reservation (never bound to a thread).
        expect(yield* second.slots.state()).toMatchObject({ used: 3, queued: 0 });
      }),
    ));
});
