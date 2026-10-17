// The hub's answer to lead-side `fleetd` calls (the LeadCallHandler port), over the ledger, leads, tasks and the train.
// The caller is already attributed to a project by its cwd; every call acts only within that project.
import type { Change, LeadCallResult, ProjectRef, WorkstreamId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import { Approvals } from "../approvals/Approvals.ts";
import { Claims } from "../checks/Claims.ts";
import { Asks } from "../ledger/Asks.ts";
import { Decisions } from "../ledger/Decisions.ts";
import { type LeadCallHandler, LeadCallRefused } from "../link/LeadCalls.ts";
import { FinishAll } from "../playbooks/FinishAll.ts";
import { Tasks } from "../tasks/Tasks.ts";
import { Train } from "../train/Train.ts";
import { ValueBar } from "../valuebar/ValueBar.ts";
import * as Workstreams from "./Workstreams.ts";

const SEARCH_LIMIT = 20;
const TASK_LIST_LIMIT = 50;

const refused = (error: { readonly code: LeadCallRefused["code"]; readonly message: string; readonly fix?: string }) =>
  new LeadCallRefused({ code: error.code, message: error.message, ...(error.fix === undefined ? {} : { fix: error.fix }) });

const result = (r: LeadCallResult) => r;

const sameProject = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

/** What the lead does next about a Change: almost always nothing, since the train and reviews move it on. */
const changeNext = (change: Change): string => {
  switch (change.state) {
    case "merged":
      return "nothing; it is merged.";
    case "needs_rebase":
    case "ci_failed":
      return `nothing unless its author is gone: the train told ${change.taskId ?? "you"} what to fix, and it retries the new head by itself.`;
    case "refused":
    case "abandoned":
      return "fix what it says and enqueue the PR again, or drop it.";
    default:
      return "don't merge it yourself or post the fleetd/train status; the train merges it and the outcome arrives in a wake.";
  }
};

export const make = Effect.gen(function* () {
  const workstreams = yield* Workstreams.Workstreams;
  const asks = yield* Asks;
  const decisions = yield* Decisions;
  const tasks = yield* Tasks;
  const claims = yield* Claims;
  const valueBar = yield* ValueBar;
  const train = yield* Train;
  const approvals = yield* Approvals;
  const finishAll = yield* FinishAll;

  /** A workstream named in a call must be one of the caller's own. */
  const ownWorkstream = (ref: ProjectRef, workstreamId: WorkstreamId) =>
    Effect.flatMap(workstreams.get(workstreamId), (w) =>
      w !== undefined && sameProject(w.projectRef, ref)
        ? Effect.succeed(w.workstreamId)
        : Effect.fail(
            refused({
              code: "not_found",
              message: `There is no workstream ${workstreamId} in your project.`,
              fix: "Use a workstream id from the digest at the top of your last wake.",
            }),
          ),
    );

  /** `fleetd decide` without --workstream: the project's only open workstream, else the caller must say. */
  const decideWorkstream = (ref: ProjectRef, workstreamId: WorkstreamId | undefined) =>
    Effect.gen(function* () {
      if (workstreamId !== undefined) return yield* ownWorkstream(ref, workstreamId);
      const open = yield* workstreams.list({ ref, open: true, limit: 2 });
      if (open.length === 1) return open[0]!.workstreamId;
      return yield* refused({
        code: "invalid",
        message: open.length === 0 ? "Your project has no open workstream to scope this decision to." : "Your project has several open workstreams.",
        fix: "Pass --workstream W<n> from your digest, or --scope project for a project-wide decision.",
      });
    });

  const handle: LeadCallHandler["handle"] = (caller, call) =>
    Effect.gen(function* () {
      const ref = caller.projectRef;
      switch (call.op) {
        case "gated_run": {
          const { op: _, workstreamId, ...input } = call;
          const own = workstreamId === undefined ? undefined : yield* ownWorkstream(ref, workstreamId);
          return yield* approvals.gatedRun(ref, caller.by, { ...input, ...(own === undefined ? {} : { workstreamId: own }) });
        }
        case "change_enqueue": {
          const { op: _, ...input } = call;
          const change = yield* train.enqueue(caller, input);
          return result({ op: "change_enqueue", change, next: changeNext(change) });
        }
        case "change_status": {
          const change = yield* train.get(call.changeId);
          if (change === undefined || !sameProject(change.projectRef, ref)) {
            return yield* refused({ code: "not_found", message: `There is no change ${call.changeId} in your project.`, fix: "Use a change id (X<n>) from your digest." });
          }
          return result({ op: "change_status", change, next: changeNext(change) });
        }
        case "brief_create":
          return yield* workstreams.briefCreate(ref, {
            workstreamId: call.workstreamId,
            brief: call.brief,
            ...(call.amend === undefined ? {} : { amend: call.amend }),
          });
        case "ask": {
          const workstreamId = call.workstreamId === undefined ? undefined : yield* ownWorkstream(ref, call.workstreamId);
          const outcome = yield* asks.create(
            {
              projectRef: ref,
              ...(workstreamId === undefined ? {} : { workstreamId }),
              kind: call.kind,
              key: call.key,
              class: call.class,
              text: call.text,
              ...(call.recommendation === undefined ? {} : { recommendation: call.recommendation }),
              ...(call.options === undefined ? {} : { options: call.options }),
              ...(call.steps === undefined ? {} : { steps: call.steps }),
              ...(call.verify === undefined ? {} : { verify: call.verify }),
              ...(call.sink === undefined ? {} : { sink: call.sink }),
              ...(call.envName === undefined ? {} : { envName: call.envName }),
              blocks: call.blocks,
              proceededOnRec: call.proceededOnRec,
            },
            caller.by,
          );
          return result({
            op: "ask",
            state: outcome.state,
            askId: outcome.ask.askId,
            ...(outcome.decision === undefined ? {} : { decision: outcome.decision }),
            ...(outcome.attached === undefined ? {} : { attached: outcome.attached }),
            ...(outcome.candidates === undefined ? {} : { candidates: outcome.candidates.slice(0, 5) }),
          });
        }
        case "ask_withdraw": {
          const ask = yield* asks.withdraw(call.askId, { projectRef: ref, ...(call.use === undefined ? {} : { use: call.use }) });
          return result({ op: "ask_withdraw", askId: ask.askId, state: ask.state });
        }
        case "decide": {
          const scope =
            call.scope === "project"
              ? ({ kind: "project", projectRef: ref } as const)
              : ({ kind: "workstream", workstreamId: yield* decideWorkstream(ref, call.workstreamId) } as const);
          const decision = yield* decisions.record(
            { key: call.key, scope, value: call.value, ...(call.why === undefined ? {} : { why: call.why }), projectRef: ref },
            { source: "lead", by: caller.by },
          );
          return result({ op: "decide", decision });
        }
        case "status_set":
          return yield* workstreams.statusSet(ref, {
            text: call.text,
            ...(call.workstreamId === undefined ? {} : { workstreamId: call.workstreamId }),
          });
        case "decisions_search":
          return result({
            op: "decisions_search",
            decisions: yield* decisions.search(call.query, { chain: { projectRef: ref }, limit: SEARCH_LIMIT }),
          });
        case "task_spawn": {
          const { op: _, ...input } = call;
          return result({ op: "task_spawn", task: yield* tasks.spawn(caller, input) });
        }
        case "task_list": {
          const listed = yield* tasks.list({
            ref,
            ...(call.state === undefined ? {} : { state: call.state }),
            ...(call.workstreamId === undefined ? {} : { workstreamId: call.workstreamId }),
            limit: TASK_LIST_LIMIT + 1,
          });
          return result({
            op: "task_list",
            tasks: listed.slice(0, TASK_LIST_LIMIT),
            ...(listed.length > TASK_LIST_LIMIT ? { truncated: true } : {}),
          });
        }
        case "task_status": {
          const task = yield* tasks.get(call.taskId);
          if (task === undefined || !sameProject(task.projectRef, ref)) {
            return yield* refused({ code: "not_found", message: `There is no task ${call.taskId} in your project.`, fix: "Run `fleetd task list`." });
          }
          return result({ op: "task_status", task });
        }
        case "task_message":
          return result({ op: "task_message", task: yield* tasks.message(caller, call.taskId, call.message) });
        case "task_cancel":
          return result({ op: "task_cancel", task: yield* tasks.cancel(caller, call.taskId, call.reason) });
        case "claim_done": {
          const outcome = yield* claims.claimDone(call.workstreamId, caller.by, { projectRef: ref });
          return result({ op: "claim_done", ...outcome });
        }
        case "workstream_spawn": {
          const spawned = yield* finishAll.spawn(caller, {
            text: call.text,
            serves: call.serves,
            ...(call.template === undefined ? {} : { template: call.template }),
          });
          return result({ op: "workstream_spawn", ...spawned });
        }
        case "inventory":
          return result({ op: "inventory", ...(yield* finishAll.inventory(caller)) });
        case "review_verdict": {
          const { op: _, ...verdict } = call;
          const recorded = yield* valueBar.recordVerdict(caller, verdict);
          const stop =
            recorded.verdict.blocking === 0
              ? "end with your one-paragraph result and stop; this commit will not be reviewed again."
              : "end with your one-paragraph result listing each blocking finding, then stop; the lead gets it.";
          return result({
            op: "review_verdict",
            verdict: recorded.verdict,
            next: recorded.research === undefined ? stop : `${recorded.research} ${stop}`,
          });
        }
      }
    }).pipe(
      Effect.catchTags({
        LeadError: (e) => Effect.fail(refused(e)),
        LedgerError: (e) => Effect.fail(refused(e)),
        ApprovalRefused: (e) => Effect.fail(refused(e)),
      }),
    );

  return { handle } satisfies LeadCallHandler;
});
