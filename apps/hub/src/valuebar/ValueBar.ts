// The value bar at spawn time (rules.ts), plus review verdicts: `fleetd review verdict` records one per review task,
// keyed by its PR and head SHA, which is what later review spawns on that PR are checked against.
import { ReviewVerdict, type ProjectRef, type Workstream } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Incidents } from "../incidents/Incidents.ts";
import { LeadError } from "../leads/LeadError.ts";
import { Playbooks } from "../playbooks/Playbooks.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as TaskRecords from "../tasks/TaskRecords.ts";
import { JudgeHook } from "./JudgeHook.ts";
import { PrHeads } from "./PrHeads.ts";
import { type PrVerdict, prKey, reviewRefusal, type SpawnRequest, writeRefusal } from "./rules.ts";

export interface Caller {
  readonly projectRef: ProjectRef;
  readonly by: string;
}

export class ValueBar extends Context.Service<
  ValueBar,
  {
    /** Refuses a spawn the value bar rules out. A polish loop is also recorded as an incident. */
    readonly checkSpawn: (caller: Caller, request: SpawnRequest, workstream: Workstream) => Effect.Effect<void, LeadError>;
    /** `fleetd review verdict`: stores it against the task's PR, emits `review.verdict` and tells the judge hook. */
    readonly recordVerdict: (caller: Caller, verdict: ReviewVerdict) => Effect.Effect<ReviewVerdict, LeadError>;
  }
>()("fleetd/valuebar/ValueBar") {}

const sameProject = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;
const encodeVerdict = Schema.encodeSync(Schema.fromJsonString(ReviewVerdict));

export const make = Effect.gen(function* () {
  const { db } = yield* HubDb.HubDb;
  const events = yield* EventLog.EventLog;
  const tasks = yield* TaskRecords.TaskRecords;
  const incidents = yield* Incidents;
  const prHeads = yield* PrHeads;
  const judge = yield* JudgeHook;
  const playbooks = yield* Playbooks;

  const sql = {
    insert: db.prepare("INSERT INTO review_verdicts (task_id, pr_key, sha, blocking, at_ms, data) VALUES (?, ?, ?, ?, ?, ?)"),
    // Enough for both rules: any clean verdict on the head, and the last two.
    forPr: db.prepare("SELECT task_id, sha, blocking FROM review_verdicts WHERE pr_key = ? ORDER BY n DESC LIMIT 200"),
  };

  const verdictsFor = (pr: string) =>
    Effect.sync(() =>
      sql.forPr.all(prKey(pr)).map((row): PrVerdict => ({ taskId: String(row.task_id), sha: String(row.sha), blocking: Number(row.blocking) })),
    );

  const refuse = (message: string, fix?: string) => new LeadError({ code: "invalid", message, ...(fix === undefined ? {} : { fix }) });

  const checkSpawn: ValueBar["Service"]["checkSpawn"] = (caller, request, workstream) =>
    Effect.gen(function* () {
      const write = writeRefusal(request, workstream);
      if (write !== undefined) return yield* refuse(write.message, write.fix);
      const pr = request.kind === "review" ? request.pr : undefined;
      const verdicts = pr === undefined ? [] : yield* verdictsFor(pr);
      // Without GitHub the SHA rule cannot apply; the polish-loop rule still does.
      const head =
        pr === undefined || verdicts.length === 0
          ? undefined
          : yield* prHeads.headSha(pr).pipe(
              Effect.catch((error) => Effect.as(Effect.logWarning("value bar: PR head unknown", { pr, error: error.message }), undefined)),
            );
      // M9 playbook hook: the pinned playbook caps review rounds.
      const pinned = workstream.playbook === undefined ? undefined : yield* playbooks.byRef(workstream.playbook);
      const review = reviewRefusal(request, caller.by, head, verdicts, pinned?.playbook.valueBar.maxReviewRounds);
      if (review === undefined) return;
      if (review.polishLoop !== undefined) {
        yield* incidents.record({ class: "polish_loop", projectRef: caller.projectRef, workstreamId: workstream.workstreamId, evidence: review.polishLoop });
      }
      return yield* refuse(review.message, review.fix);
    });

  const recordVerdict: ValueBar["Service"]["recordVerdict"] = (caller, verdict) =>
    Effect.gen(function* () {
      const task = (yield* tasks.get(verdict.taskId))?.task;
      if (task === undefined || !sameProject(task.projectRef, caller.projectRef)) {
        return yield* new LeadError({ code: "not_found", message: `No task ${verdict.taskId} in this project.`, fix: "Pass --task with your own task id." });
      }
      if (task.kind !== "review") {
        return yield* refuse(`${task.taskId} is a ${task.kind} task; only review tasks record verdicts.`);
      }
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      yield* Effect.sync(() =>
        sql.insert.run(task.taskId, task.pr === undefined ? null : prKey(task.pr), verdict.prHeadSha, verdict.blocking, nowMs, encodeVerdict(verdict)),
      );
      yield* events.append({
        at: DateTime.formatIso(now),
        type: "review.verdict",
        machineId: task.projectRef.machineId,
        projectId: task.projectRef.projectId,
        ...(task.threadRef === undefined ? {} : { threadId: task.threadRef.threadId }),
        summary: `${task.taskId} review verdict at ${verdict.prHeadSha.slice(0, 12)}: ${verdict.blocking} blocking, ${verdict.nonBlocking} non-blocking`,
        data: {
          taskId: task.taskId,
          workstreamId: task.workstreamId,
          prHeadSha: verdict.prHeadSha,
          blocking: verdict.blocking,
          nonBlocking: verdict.nonBlocking,
          ...(task.pr === undefined ? {} : { pr: task.pr }),
        },
      });
      yield* judge.onVerdict(task.taskId, verdict);
      return verdict;
    });

  return ValueBar.of({ checkSpawn, recordVerdict });
});

/** Needs HubDb, EventLog, TaskRecords, Incidents, PrHeads, JudgeHook and Playbooks. */
export const layer = Layer.effect(ValueBar, make);
