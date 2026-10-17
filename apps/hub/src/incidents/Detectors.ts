// Incident detectors that read the event log: stalls, writes outside a task's areas, and the two ledger smells, a
// human asked about a key that was already decided (re_ask) and a human replacing a lead's decision (override).
// The other classes are recorded where the hub sees them happen (claims, estimates, the value bar, the train, the
// inbox). Events from the hub's start on; nothing here reads a model.
import type { Decision, DecisionId, HubEvent, HubEventType, MachineId, ProjectId, ProjectRef, TaskId, ThreadId, WorkstreamId } from "@fleetd/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Asks } from "../ledger/Asks.ts";
import { Decisions } from "../ledger/Decisions.ts";
import { decisionN } from "../ledger/LedgerRepo.ts";
import * as EventLog from "../store/EventLog.ts";
import * as TaskRecords from "../tasks/TaskRecords.ts";
import { Incidents, type IncidentInput } from "./Incidents.ts";

const TYPES: ReadonlyArray<HubEventType> = ["thread.stalled", "thread.failed", "task.out_of_area", "decision.recorded"];

interface EventData {
  readonly reason?: string;
  readonly taskId?: TaskId;
  readonly workstreamId?: WorkstreamId;
  readonly paths?: ReadonlyArray<string>;
  readonly decisionId?: DecisionId;
  readonly source?: string;
  readonly supersedes?: DecisionId;
}

const refOf = (event: HubEvent): ProjectRef | undefined =>
  event.machineId === undefined || event.projectId === undefined
    ? undefined
    : { machineId: event.machineId as MachineId, projectId: event.projectId as ProjectId };

const short = (value: string) => (value.length > 80 ? `${value.slice(0, 79)}…` : value);

export const make = Effect.gen(function* () {
  const incidents = yield* Incidents;
  const decisions = yield* Decisions;
  const asks = yield* Asks;
  const tasks = yield* TaskRecords.TaskRecords;

  const record = (input: IncidentInput) => Effect.asVoid(incidents.record(input));

  /** A stall, or a second stall that failed the chain. */
  const stall = (event: HubEvent, ref: ProjectRef) =>
    Effect.gen(function* () {
      const task = event.threadId === undefined ? undefined : (yield* tasks.byThread({ machineId: ref.machineId, threadId: event.threadId as ThreadId }))?.task;
      yield* record({
        class: "stall",
        projectRef: ref,
        ...(task === undefined ? {} : { workstreamId: task.workstreamId, taskId: task.taskId }),
        evidence: [event.summary],
      });
    });

  /** The decisions a human one displaced: the one it superseded, and lead decisions still active on its key in the project. */
  const displaced = (decision: Decision, ref: ProjectRef | undefined, supersedes: DecisionId | undefined) =>
    Effect.gen(function* () {
      const found = new Map<string, Decision>();
      if (supersedes !== undefined) {
        const old = yield* decisions.get(supersedes);
        if (old !== undefined) found.set(old.decisionId, old);
      }
      if (ref !== undefined) for (const d of yield* decisions.activeOnKey(decision.key, ref)) if (d.decisionId !== decision.decisionId) found.set(d.decisionId, d);
      return [...found.values()].filter((d) => Date.parse(d.at) <= Date.parse(decision.at));
    });

  const humanDecision = (event: HubEvent, data: EventData) =>
    Effect.gen(function* () {
      if (data.decisionId === undefined) return;
      const decision = yield* decisions.get(data.decisionId);
      const ref = refOf(event);
      // Global decisions have no project to charge; leads never decide globally.
      if (decision === undefined || ref === undefined) return;
      const before = yield* displaced(decision, ref, data.supersedes);
      const workstreamOf = (d: Decision) => (d.scope.kind === "workstream" ? { workstreamId: d.scope.workstreamId } : {});
      const overridden = before.find((d) => d.source === "lead" && d.value.trim() !== decision.value.trim());
      if (overridden !== undefined) {
        yield* record({
          class: "override",
          projectRef: ref,
          ...workstreamOf(overridden),
          evidence: [
            `${decision.decisionId} by ${decision.by ?? "a human"} set ${decision.key} = "${short(decision.value)}" over the lead's ${overridden.decisionId} = "${short(overridden.value)}"`,
          ],
        });
      }
      // An answer to an ask whose key was already decided. Asks the lead filed after proceeding on its
      // recommendation exist to be confirmed, so those are not re-asks.
      if (decision.askId === undefined || before.length === 0) return;
      const ask = yield* asks.get(decision.askId);
      if (ask === undefined || ask.proceededOnRec) return;
      const prior = before.toSorted((a, b) => decisionN(b.decisionId)! - decisionN(a.decisionId)!)[0]!;
      yield* record({
        class: "re_ask",
        projectRef: ref,
        ...(ask.workstreamId === undefined ? workstreamOf(prior) : { workstreamId: ask.workstreamId }),
        evidence: [
          `${ask.askId} asked the human about ${decision.key}, already decided by ${prior.decisionId} (${prior.source}) = "${short(prior.value)}"; answered ${decision.decisionId} = "${short(decision.value)}"`,
        ],
      });
    });

  const onEvent = (event: HubEvent) =>
    Effect.gen(function* () {
      const data = (event.data ?? {}) as EventData;
      const ref = refOf(event);
      switch (event.type) {
        case "thread.stalled":
          if (ref !== undefined) yield* stall(event, ref);
          return;
        case "thread.failed":
          if (ref !== undefined && data.reason === "stalled") yield* stall(event, ref);
          return;
        case "task.out_of_area":
          if (ref === undefined) return;
          yield* record({
            class: "out_of_area",
            projectRef: ref,
            ...(data.workstreamId === undefined ? {} : { workstreamId: data.workstreamId }),
            ...(data.taskId === undefined ? {} : { taskId: data.taskId }),
            evidence: [event.summary, ...(data.paths ?? []).slice(0, 10)],
          });
          return;
        case "decision.recorded":
          if (data.source === "human") yield* humanDecision(event, data);
          return;
      }
    });

  return { onEvent };
});

/** Follows the event log from the hub's start. Needs EventLog, Incidents, Decisions, Asks and TaskRecords. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { onEvent } = yield* make;
    const events = yield* EventLog.EventLog;
    let cursor = yield* events.head();
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const page = yield* events.wait({ cursor, types: TYPES, timeoutSec: 3600 });
          cursor = page.cursor;
          for (const event of page.events) {
            yield* onEvent(event).pipe(
              Effect.catchCause((cause) => Effect.logWarning("incident detector failed", { seq: event.seq, type: event.type, cause: Cause.pretty(cause) })),
            );
          }
        }),
      ),
    );
  }),
);
