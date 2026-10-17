import type { Brief, Tier, WorkstreamId } from "@fleetd/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as Incidents from "../incidents/Incidents.ts";
import * as LeadRecords from "../leads/LeadRecords.ts";
import * as Playbooks from "../playbooks/Playbooks.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import { REF } from "../tasks/testKit.ts";
import * as Estimates from "./Estimates.ts";

const layer = Estimates.layer.pipe(
  Layer.provideMerge(Incidents.layer),
  Layer.provideMerge(Layer.mergeAll(LeadRecords.layer, EventLog.layer, Playbooks.layer())),
  Layer.provideMerge(HubDb.layerMemory),
  Layer.provideMerge(TestClock.layer()),
);
const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) => Effect.runPromise(Effect.scoped(Effect.provide(effect, layer)));

/** A running workstream with this brief tier and raw estimate (none when undefined). */
const workstream = (tier: Tier, rawMinutes: number | undefined) =>
  Effect.gen(function* () {
    const records = yield* LeadRecords.LeadRecords;
    const { workstream } = yield* records.workstreams.create({
      ref: REF,
      title: "w",
      source: { text: "w", channel: "app", by: "human", at: "2026-10-17T10:00:00.000Z" },
    });
    const brief = {
      goal: "g",
      why: "y",
      pointers: [],
      constraints: [],
      doneWhen: [{ type: "pr_merged", repo: "wynn-dev/lab" }],
      tier,
      ...(rawMinutes === undefined ? {} : { estimate: { rawMinutes, gates: [] } }),
    } as Brief;
    yield* records.workstreams.put({ workstream: { ...workstream, brief, state: "running" }, amends: [] });
    return workstream.workstreamId;
  });

const get = (id: WorkstreamId) => Effect.map(Effect.flatMap(LeadRecords.LeadRecords, (r) => r.workstreams.get(id)), (s) => s!.workstream);

/** Starts a workstream, lets `actual` minutes pass and marks it done. */
const complete = (tier: Tier, raw: number, actual: number) =>
  Effect.gen(function* () {
    const estimates = yield* Estimates.Estimates;
    const id = yield* workstream(tier, raw);
    yield* estimates.recordStart(id);
    yield* TestClock.adjust(Duration.minutes(actual));
    yield* estimates.recordDone(id);
    return id;
  });

describe("Estimates", () => {
  it("saves ratioAtStart when the clock starts and actualMinutes when the workstream is done", () =>
    run(
      Effect.gen(function* () {
        const estimates = yield* Estimates.Estimates;
        const id = yield* workstream("M", 30);
        yield* estimates.recordStart(id);
        expect((yield* get(id)).estimateActual).toEqual({ ratioAtStart: 5 });
        // A second start (a replayed event) keeps the first clock.
        yield* TestClock.adjust(Duration.minutes(10));
        yield* estimates.recordStart(id);
        yield* TestClock.adjust(Duration.minutes(35));
        yield* estimates.recordDone(id);
        expect((yield* get(id)).estimateActual).toEqual({ ratioAtStart: 5, actualMinutes: 45 });
        // Done once: later calls change nothing.
        yield* TestClock.adjust(Duration.minutes(60));
        yield* estimates.recordDone(id);
        expect((yield* get(id)).estimateActual).toEqual({ ratioAtStart: 5, actualMinutes: 45 });
      }),
    ));

  it("ignores workstreams without a raw estimate", () =>
    run(
      Effect.gen(function* () {
        const estimates = yield* Estimates.Estimates;
        const id = yield* workstream("S", undefined);
        yield* estimates.recordStart(id);
        yield* estimates.recordDone(id);
        const w = yield* get(id);
        expect(w.estimateActual).toBeUndefined();
        expect(yield* estimates.eta(w)).toBeUndefined();
      }),
    ));

  it("records an estimate_miss incident only past twice the raw estimate", () =>
    run(
      Effect.gen(function* () {
        yield* complete("S", 10, 20);
        expect(yield* (yield* Incidents.Incidents).list({ limit: 10 })).toEqual([]);
        const late = yield* complete("S", 10, 25);
        const incidents = yield* (yield* Incidents.Incidents).list({ limit: 10 });
        expect(incidents).toHaveLength(1);
        expect(incidents[0]).toMatchObject({ class: "estimate_miss", workstreamId: late, projectRef: REF });
        expect(incidents[0]!.evidence[0]).toBe(`${late} (tier S) took 25 min against a raw estimate of 10 min: 2.5x, over the 2x limit.`);
      }),
    ));

  it("calibrates the ETA from the tier's done workstreams: the prior until 5, the median from 5, p80 from 10", () =>
    run(
      Effect.gen(function* () {
        const estimates = yield* Estimates.Estimates;
        const open = yield* workstream("M", 60);
        const eta = Effect.flatMap(get(open), (w) => estimates.eta(w));

        for (const ratio of [1, 1.5, 2, 1.2]) yield* complete("M", 10, 10 * ratio);
        // Another tier never counts.
        for (let i = 0; i < 5; i++) yield* complete("L", 10, 100);
        expect(yield* eta).toEqual({ rawMinutes: 60, calibratedMinutes: 300, ratio: 5, samples: 4 });

        yield* complete("M", 10, 30);
        // Ratios 1, 1.2, 1.5, 2, 3: median 1.5.
        expect(yield* eta).toEqual({ rawMinutes: 60, calibratedMinutes: 90, ratio: 1.5, samples: 5 });

        for (const ratio of [1, 1, 2, 2, 4]) yield* complete("M", 10, 10 * ratio);
        // 1, 1, 1, 1.2, 1.5, 2, 2, 2, 3, 4: median 1.75, p80 (8th) 2.
        expect(yield* eta).toEqual({ rawMinutes: 60, calibratedMinutes: 105, ratio: 1.75, samples: 10, p80Minutes: 120 });

        // The next workstream to start saves the tier's ratio of the moment.
        yield* (yield* Estimates.Estimates).recordStart(open);
        expect((yield* get(open)).estimateActual).toEqual({ ratioAtStart: 1.75 });
      }),
    ));
});
