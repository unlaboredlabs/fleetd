// Research verdicts: the judge reports the metric for baseline and candidate, and the hub applies the brief's frozen
// decision rule. Every outcome ends the workstream as done; STOP and INCONCLUSIVE answer the question too.
import { type MetricValues, researchOutcome, type ResearchVerdict, type Workstream, type WorkstreamId } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Estimates from "../estimates/Estimates.ts";
import { LeadError } from "../leads/LeadError.ts";
import * as LeadRecords from "../leads/LeadRecords.ts";
import * as LeadWakes from "../leads/LeadWakes.ts";
import * as EventLog from "../store/EventLog.ts";
import { verdictText } from "./verdict.ts";

export class Research extends Context.Service<
  Research,
  {
    /**
     * Computes and stores the verdict for the judge's numbers, marks the workstream done with its outcome, emits
     * `research.verdict` and tells the lead. A verdict is final: a second call returns the stored one.
     */
    readonly recordVerdict: (
      workstreamId: WorkstreamId,
      metricValues: MetricValues,
    ) => Effect.Effect<{ readonly workstream: Workstream; readonly text: string }, LeadError>;
  }
>()("fleetd/playbooks/Research") {}

export const make = Effect.gen(function* () {
  const records = yield* LeadRecords.LeadRecords;
  const events = yield* EventLog.EventLog;
  const estimates = yield* Estimates.Estimates;
  const wakes = yield* LeadWakes.LeadWakes;
  const lock = Semaphore.makeUnsafe(1);

  const recordVerdict: Research["Service"]["recordVerdict"] = (workstreamId, metricValues) =>
    Effect.gen(function* () {
      const stored = yield* records.workstreams.get(workstreamId);
      if (stored === undefined) return yield* new LeadError({ code: "not_found", message: `There is no workstream ${workstreamId}.` });
      const w = stored.workstream;
      const textOf = (v: ResearchVerdict) => `${w.workstreamId} research verdict ${verdictText(v.outcome, v.rule, v.metricValues, w.brief?.metric)}`;
      if (w.verdict !== undefined) return { workstream: w, text: textOf(w.verdict) };
      if (w.playbook?.startsWith("research@") !== true) {
        return yield* new LeadError({ code: "invalid", message: `${workstreamId} is not a research workstream; only research gets a verdict.` });
      }
      const rule = w.brief?.decisionRule;
      if (rule === undefined) {
        return yield* new LeadError({ code: "invalid", message: `${workstreamId} has no frozen decision rule, so its numbers decide nothing.` });
      }
      if (w.state === "stopped" || w.state === "failed") {
        return yield* new LeadError({ code: "invalid", message: `${workstreamId} is ${w.state}; it gets no verdict.` });
      }
      const now = yield* DateTime.now;
      const at = DateTime.formatIso(now);
      const verdict: ResearchVerdict = { outcome: researchOutcome(rule, metricValues), metricValues, rule, computedAt: at };
      const done: Workstream = { ...w, state: "done", outcome: verdict.outcome, verdict, updatedAt: at };
      const text = textOf(verdict);
      yield* records.workstreams.put({ ...stored, workstream: done });
      const where = { machineId: w.projectRef.machineId, projectId: w.projectRef.projectId };
      yield* events.append({
        at,
        type: "research.verdict",
        ...where,
        summary: text.slice(0, 500),
        data: { workstreamId, outcome: verdict.outcome, metricValues },
      });
      if (w.state !== "done") {
        yield* events.append({ at, type: "workstream.done", ...where, summary: `${workstreamId} is done (${verdict.outcome}): ${w.title}`, data: { workstreamId } });
        yield* estimates.recordDone(workstreamId);
      }
      yield* wakes.trigger(w.projectRef, { kind: "research_verdict", workstreamId, line: text });
      return { workstream: done, text };
    }).pipe(lock.withPermit);

  return Research.of({ recordVerdict });
});

/** Needs LeadRecords, EventLog, Estimates and LeadWakes. */
export const layer = Layer.effect(Research, make);
