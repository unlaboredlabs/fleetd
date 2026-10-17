// The fixed metrics a retro change is judged by. They are code, not something the retro can edit. Counts are over
// one playbook: incidents on workstreams that pinned it (any version), plus incidents on no workstream at all,
// which no playbook owns and every playbook's leads can cause.
import type { PlaybookName, RetroMetricClass, RetroSnapshot, WorkstreamId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import { Incidents } from "../incidents/Incidents.ts";
import * as LeadRecords from "../leads/LeadRecords.ts";
import * as TaskRecords from "../tasks/TaskRecords.ts";

/** Any regression on one of these reverts a wording change, whatever its own metric did. */
export const GUARDED = ["false_claim", "estimate_miss", "polish_loop", "agent_minutes_per_done"] as const;

export const DAY_MS = 86_400_000;

const SCAN = 5000;

const round1 = (n: number) => Math.round(n * 10) / 10;

export const makeMetrics = Effect.gen(function* () {
  const incidents = yield* Incidents;
  const records = yield* LeadRecords.LeadRecords;
  const tasks = yield* TaskRecords.TaskRecords;

  const playbookOf = (cache: Map<string, string | undefined>, id: WorkstreamId) =>
    Effect.gen(function* () {
      if (!cache.has(id)) cache.set(id, (yield* records.workstreams.get(id))?.workstream.playbook?.split("@")[0]);
      return cache.get(id);
    });

  const counts = (playbook: PlaybookName, fromMs: number, toMs: number) =>
    Effect.gen(function* () {
      const cache = new Map<string, string | undefined>();
      const byClass = new Map<string, number>();
      for (const incident of yield* incidents.list({ sinceMs: fromMs, untilMs: toMs, limit: SCAN })) {
        if (incident.workstreamId !== undefined && (yield* playbookOf(cache, incident.workstreamId)) !== playbook) continue;
        byClass.set(incident.class, (byClass.get(incident.class) ?? 0) + 1);
      }
      return byClass;
    });

  /** Mean task run minutes of the playbook's workstreams that finished in the window; null when none did. */
  const agentMinutes = (playbook: PlaybookName, fromMs: number, toMs: number) =>
    Effect.gen(function* () {
      const done = (yield* records.workstreams.list({ state: "done", limit: SCAN })).filter((w) => w.playbook?.startsWith(`${playbook}@`) && Date.parse(w.updatedAt) >= fromMs && Date.parse(w.updatedAt) < toMs);
      if (done.length === 0) return null;
      let minutes = 0;
      for (const w of done) {
        for (const task of yield* tasks.list({ workstreamId: w.workstreamId, limit: 500 })) {
          if (task.startedAt !== undefined && task.endedAt !== undefined) minutes += Math.max(0, Date.parse(task.endedAt) - Date.parse(task.startedAt)) / 60_000;
        }
      }
      return round1(minutes / done.length);
    });

  /** The target metric and every guarded one over [fromMs, toMs). */
  const snapshot = (playbook: PlaybookName, target: RetroMetricClass, fromMs: number, toMs: number) =>
    Effect.gen(function* () {
      const byClass = yield* counts(playbook, fromMs, toMs);
      const minutes = yield* agentMinutes(playbook, fromMs, toMs);
      const count = (c: string) => byClass.get(c) ?? 0;
      return {
        target: target === "agent_minutes_per_done" ? minutes : count(target),
        false_claim: count("false_claim"),
        estimate_miss: count("estimate_miss"),
        polish_loop: count("polish_loop"),
        agent_minutes_per_done: minutes,
      } satisfies RetroSnapshot;
    });

  return { snapshot };
});

/**
 * Kept when the target went down and no guarded metric went up; otherwise the reason it reverts. A metric with no
 * value on either side (no workstream finished) counts as unchanged.
 */
export const judge = (baseline: RetroSnapshot, measured: RetroSnapshot): { readonly kept: true } | { readonly kept: false; readonly reason: string } => {
  if (baseline.target === null || measured.target === null || !(measured.target < baseline.target)) {
    return { kept: false, reason: `the metric did not improve (${baseline.target ?? "none"} before, ${measured.target ?? "none"} after)` };
  }
  for (const g of GUARDED) {
    const before = baseline[g];
    const after = measured[g];
    if (before !== null && after !== null && after > before) return { kept: false, reason: `${g} regressed (${before} before, ${after} after)` };
  }
  return { kept: true };
};
