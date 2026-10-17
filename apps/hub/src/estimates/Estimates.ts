// Estimates vs actuals. When a workstream with a raw estimate starts running, its tier's ratio is saved as
// `ratioAtStart`; when it is done, the wall-clock minutes since then are its actual. A tier's ratio is the median
// actual/raw of its latest done workstreams (calibration.ts), and an actual over twice the raw is an incident.
import type { Eta, Tier, Workstream, WorkstreamId } from "@fleetd/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Incidents } from "../incidents/Incidents.ts";
import * as LeadRecords from "../leads/LeadRecords.ts";
import { Playbooks } from "../playbooks/Playbooks.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import { calibrate, etaOf, MISS_RATIO, WINDOW } from "./calibration.ts";

export class Estimates extends Context.Service<
  Estimates,
  {
    /** Saves the tier's current ratio as `ratioAtStart` and starts the clock. Once per workstream; no-op without a raw estimate. */
    readonly recordStart: (workstreamId: WorkstreamId) => Effect.Effect<void>;
    /** Stores `actualMinutes`, records `Incident{estimate_miss}` past 2x the raw. Once per workstream; no-op if it never started the clock. */
    readonly recordDone: (workstreamId: WorkstreamId) => Effect.Effect<void>;
    /** Undefined without a raw estimate in the brief. */
    readonly eta: (workstream: Workstream) => Effect.Effect<Eta | undefined>;
  }
>()("fleetd/estimates/Estimates") {}

const round1 = (n: number) => Math.round(n * 10) / 10;

export const make = Effect.gen(function* () {
  const { db } = yield* HubDb.HubDb;
  const records = yield* LeadRecords.LeadRecords;
  const incidents = yield* Incidents;
  const playbooks = yield* Playbooks;

  const sql = {
    get: db.prepare("SELECT * FROM estimates WHERE workstream_id = ?"),
    start: db.prepare(
      "INSERT OR IGNORE INTO estimates (workstream_id, tier, raw_minutes, ratio_at_start, started_ms) VALUES (?, ?, ?, ?, ?)",
    ),
    done: db.prepare("UPDATE estimates SET done_ms = ?, actual_minutes = ? WHERE workstream_id = ? AND done_ms IS NULL"),
    ratios: db.prepare(
      `SELECT actual_minutes / raw_minutes AS ratio FROM estimates
       WHERE tier = ? AND done_ms IS NOT NULL AND raw_minutes > 0 ORDER BY done_ms DESC LIMIT ?`,
    ),
  };

  // M9 playbook hook: below MIN_SAMPLES the workstream's pinned playbook supplies the prior.
  const calibrationOf = (tier: Tier, workstream: Workstream) =>
    Effect.gen(function* () {
      const pinned = workstream.playbook === undefined ? undefined : yield* playbooks.byRef(workstream.playbook);
      return calibrate(
        sql.ratios.all(tier, WINDOW).map((row) => Number(row.ratio)),
        pinned?.playbook.estimatePrior,
      );
    });

  const putEstimateActual = (workstreamId: WorkstreamId, estimateActual: NonNullable<Workstream["estimateActual"]>) =>
    Effect.gen(function* () {
      const stored = yield* records.workstreams.get(workstreamId);
      if (stored === undefined) return;
      yield* records.workstreams.put({ ...stored, workstream: { ...stored.workstream, estimateActual } });
    });

  const recordStart: Estimates["Service"]["recordStart"] = (workstreamId) =>
    Effect.gen(function* () {
      const workstream = (yield* records.workstreams.get(workstreamId))?.workstream;
      const brief = workstream?.brief;
      if (workstream === undefined || brief?.estimate === undefined || sql.get.get(workstreamId) !== undefined) return;
      const { ratio } = yield* calibrationOf(brief.tier, workstream);
      const now = yield* Clock.currentTimeMillis;
      sql.start.run(workstreamId, brief.tier, brief.estimate.rawMinutes, ratio, now);
      yield* putEstimateActual(workstreamId, { ratioAtStart: ratio });
    });

  const recordDone: Estimates["Service"]["recordDone"] = (workstreamId) =>
    Effect.gen(function* () {
      const row = sql.get.get(workstreamId);
      if (row === undefined || row.done_ms !== null) return;
      const now = yield* Clock.currentTimeMillis;
      const actualMinutes = round1(Math.max(0, now - Number(row.started_ms)) / 60_000);
      const rawMinutes = Number(row.raw_minutes);
      const ratioAtStart = Number(row.ratio_at_start);
      sql.done.run(now, actualMinutes, workstreamId);
      yield* putEstimateActual(workstreamId, { ratioAtStart, actualMinutes });
      if (rawMinutes <= 0 || actualMinutes / rawMinutes <= MISS_RATIO) return;
      const workstream = (yield* records.workstreams.get(workstreamId))?.workstream;
      if (workstream === undefined) return;
      yield* incidents.record({
        class: "estimate_miss",
        projectRef: workstream.projectRef,
        workstreamId,
        evidence: [
          `${workstreamId} (tier ${String(row.tier)}) took ${actualMinutes} min against a raw estimate of ${rawMinutes} min: ${round1(actualMinutes / rawMinutes)}x, over the ${MISS_RATIO}x limit.`,
          `The calibrated estimate at start was ${round1(rawMinutes * ratioAtStart)} min (ratio ${ratioAtStart}).`,
        ],
      });
    });

  const eta: Estimates["Service"]["eta"] = (workstream) => {
    const brief = workstream.brief;
    if (brief?.estimate === undefined) return Effect.succeed(undefined);
    const raw = brief.estimate.rawMinutes;
    return Effect.map(calibrationOf(brief.tier, workstream), (c) => etaOf(raw, c));
  };

  return Estimates.of({ recordStart, recordDone, eta });
});

/** Needs HubDb, LeadRecords, Incidents and Playbooks. */
export const layer = Layer.effect(Estimates, make);

/** Starts the clock on every `workstream.running` event from the hub's start on. Needs Estimates and EventLog. */
export const layerStartOnRunning = Layer.effectDiscard(
  Effect.gen(function* () {
    const estimates = yield* Estimates;
    const events = yield* EventLog.EventLog;
    let cursor = yield* events.head();
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const page = yield* events.wait({ cursor, types: ["workstream.running"], timeoutSec: 3600 });
          cursor = page.cursor;
          for (const event of page.events) {
            const id = (event.data as { readonly workstreamId?: WorkstreamId } | undefined)?.workstreamId;
            if (id === undefined) continue;
            yield* estimates
              .recordStart(id)
              .pipe(Effect.catchCause((cause) => Effect.logWarning("estimate start not recorded", { workstreamId: id, cause: Cause.pretty(cause) })));
          }
        }),
      ),
    );
  }),
);
