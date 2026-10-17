// The hub's answer to lead-side `fleetd` calls (the LeadCallHandler port), over the ledger and leads services.
// The caller is already attributed to a project by its cwd; every call acts only within that project.
import type { LeadCallResult, ProjectRef, WorkstreamId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import { Asks } from "../ledger/Asks.ts";
import { Decisions } from "../ledger/Decisions.ts";
import { type LeadCallHandler, LeadCallRefused } from "../link/LeadCalls.ts";
import * as Workstreams from "./Workstreams.ts";

const SEARCH_LIMIT = 20;

const refused = (error: { readonly code: LeadCallRefused["code"]; readonly message: string; readonly fix?: string }) =>
  new LeadCallRefused({ code: error.code, message: error.message, ...(error.fix === undefined ? {} : { fix: error.fix }) });

const result = (r: LeadCallResult) => r;

const sameProject = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

export const make = Effect.gen(function* () {
  const workstreams = yield* Workstreams.Workstreams;
  const asks = yield* Asks;
  const decisions = yield* Decisions;

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
      }
      // Every other op returned above; ending here keeps the generator's return type free of `undefined`.
      return result({
        op: "decisions_search",
        decisions: yield* decisions.search(call.query, { chain: { projectRef: ref }, limit: SEARCH_LIMIT }),
      });
    }).pipe(Effect.catchTags({ LeadError: (e) => Effect.fail(refused(e)), LedgerError: (e) => Effect.fail(refused(e)) }));

  return { handle } satisfies LeadCallHandler;
});
