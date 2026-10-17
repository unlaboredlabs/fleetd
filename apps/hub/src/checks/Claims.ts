// `claim done`: the lead only claims; the hub moves the workstream to verifying, runs its frozen done-when checks in
// index order, and only all of them passing makes it done. A failure wakes the lead with each failing check's
// evidence; the third failed claim on a workstream is a false-claim incident.
import type { Claim, ClaimId, CheckResult, ProjectRef, Workstream, WorkstreamId, WorkstreamState } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { Estimates } from "../estimates/Estimates.ts";
import { Incidents } from "../incidents/Incidents.ts";
import { LeadError } from "../leads/LeadError.ts";
import * as LeadRecords from "../leads/LeadRecords.ts";
import * as LeadWakes from "../leads/LeadWakes.ts";
import * as EventLog from "../store/EventLog.ts";
import { CheckRunner, ranByOf } from "./CheckRunner.ts";
import * as ClaimRecords from "./ClaimRecords.ts";
import { failedClaimEvidence } from "./render.ts";

/** Under the node's 30 s answer timeout for lead calls; slower claims report through a wake. */
export const INLINE_WAIT = Duration.seconds(20);
export const FALSE_CLAIM_AT = 3;

export interface ClaimDoneOutcome {
  readonly claimId: ClaimId;
  readonly workstreamId: WorkstreamId;
  readonly state: WorkstreamState;
  /** Present when every check finished within the call. */
  readonly claim?: Claim;
  readonly next: string;
}

export class Claims extends Context.Service<
  Claims,
  {
    /**
     * Starts a claim on the workstream and waits up to INLINE_WAIT for its checks. With `projectRef`, refuses another
     * project's workstream. A new claim supersedes one still running on the same workstream.
     */
    readonly claimDone: (
      workstreamId: WorkstreamId,
      by: string,
      options?: { readonly projectRef?: ProjectRef },
    ) => Effect.Effect<ClaimDoneOutcome, LeadError>;
    readonly get: (claimId: ClaimId) => Effect.Effect<Claim | undefined>;
    /** Finished claims, newest first. */
    readonly list: ClaimRecords.ClaimRecords["Service"]["list"];
  }
>()("fleetd/checks/Claims") {}

const sameProject = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

/** Only these are worth a judge's or the human's time once an earlier check failed. */
const ASKS_SOMEONE: ReadonlySet<string> = new Set(["judge", "human"]);

export interface ClaimsOptions {
  readonly inlineWait?: Duration.Input;
}

export const make = (options: ClaimsOptions = {}) =>
  Effect.gen(function* () {
    const records = yield* ClaimRecords.ClaimRecords;
    const leadRecords = yield* LeadRecords.LeadRecords;
    const runner = yield* CheckRunner;
    const events = yield* EventLog.EventLog;
    const wakes = yield* LeadWakes.LeadWakes;
    const estimates = yield* Estimates;
    const incidents = yield* Incidents;
    const scope = yield* Effect.scope;
    const running = yield* FiberMap.make<WorkstreamId, Claim>();
    // Workstream state changes go through this, so a claim's start and another's end never interleave.
    const lock = Semaphore.makeUnsafe(1);
    const inlineWait = Duration.fromInputUnsafe(options.inlineWait ?? INLINE_WAIT);
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

    const emit = (w: Workstream, type: "claim.failed" | "claim.passed" | "workstream.done" | "workstream.state", summary: string, data: object) =>
      Effect.flatMap(nowIso, (at) =>
        events.append({ at, type, machineId: w.projectRef.machineId, projectId: w.projectRef.projectId, summary, data }),
      );

    const notFound = (workstreamId: WorkstreamId) =>
      new LeadError({ code: "not_found", message: `There is no workstream ${workstreamId}.`, fix: "Use a workstream id from your digest." });

    const runChecks = (w: Workstream, claimId: ClaimId) =>
      Effect.gen(function* () {
        const results: Array<CheckResult> = [];
        for (const [index, spec] of (w.brief?.doneWhen ?? []).entries()) {
          if (ASKS_SOMEONE.has(spec.type) && results.some((r) => r.result !== "pass")) {
            results.push({
              checkIndex: index,
              spec,
              result: "error",
              evidence: "not run: a judge or the human is asked only once every earlier check passes",
              ranBy: ranByOf(spec),
              at: yield* nowIso,
            });
            continue;
          }
          results.push(yield* runner.run({ workstream: w, claimId }, index, spec));
        }
        return results;
      });

    /** Stores the claim and acts on it. The workstream is re-read: it may have been stopped while checks ran. */
    const conclude = (claim: Claim) =>
      Effect.gen(function* () {
        yield* records.finish(claim);
        const stored = yield* leadRecords.workstreams.get(claim.workstreamId);
        if (stored === undefined) return;
        const w = stored.workstream;
        // A research judge's numbers already made it done, with its verdict.
        if (w.state === "done") return;
        const passed = claim.outcome === "pass";
        const label = `${claim.claimId} on ${w.workstreamId}`;
        if (passed) {
          if (w.state !== "verifying") return;
          const done: Workstream = { ...w, state: "done", updatedAt: yield* nowIso };
          yield* leadRecords.workstreams.put({ ...stored, workstream: done });
          yield* emit(w, "claim.passed", `${label} passed: all ${claim.results.length} checks`, { claimId: claim.claimId, workstreamId: w.workstreamId });
          yield* emit(w, "workstream.done", `${w.workstreamId} is done: ${w.title}`, { workstreamId: w.workstreamId, claimId: claim.claimId });
          yield* estimates.recordDone(w.workstreamId);
          return;
        }
        const failures = claim.results.filter((r) => r.result !== "pass");
        yield* emit(w, "claim.failed", `${label} failed: ${failures.length} of ${claim.results.length} checks did not pass`, {
          claimId: claim.claimId,
          workstreamId: w.workstreamId,
          failing: failures.map((r) => r.checkIndex),
        });
        yield* wakes.trigger(w.projectRef, { kind: "claim_failed", claimId: claim.claimId, workstreamId: w.workstreamId, failures });
        const failed = yield* records.list({ workstreamId: w.workstreamId, outcome: "fail", limit: 20 });
        if (failed.length === FALSE_CLAIM_AT) {
          yield* incidents.record({
            class: "false_claim",
            projectRef: w.projectRef,
            workstreamId: w.workstreamId,
            evidence: [...failed].reverse().map((c) => failedClaimEvidence(c.claimId, c.results)),
          });
        }
      }).pipe(
        // Waiting for the lock stays interruptible, so a superseded claim gives way; once it holds it, it finishes.
        Effect.uninterruptible,
        lock.withPermit,
      );

    const runClaim = (w: Workstream, claimId: ClaimId, by: string, at: string) =>
      Effect.gen(function* () {
        const results = yield* runChecks(w, claimId);
        const claim: Claim = {
          claimId,
          workstreamId: w.workstreamId,
          by,
          at,
          results,
          outcome: results.every((r) => r.result === "pass") ? "pass" : "fail",
        };
        yield* conclude(claim);
        return claim;
      });

    const start = (workstreamId: WorkstreamId, by: string, projectRef: ProjectRef | undefined) =>
      Effect.gen(function* () {
        const stored = yield* leadRecords.workstreams.get(workstreamId);
        if (stored === undefined) return yield* notFound(workstreamId);
        const w = stored.workstream;
        if (projectRef !== undefined && !sameProject(w.projectRef, projectRef)) return yield* notFound(workstreamId);
        if (w.state === "done") {
          return yield* new LeadError({ code: "invalid", message: `${workstreamId} is already done.`, fix: "Open a new intent if there is more to do." });
        }
        if (w.state === "stopped" || w.state === "failed") {
          return yield* new LeadError({ code: "invalid", message: `${workstreamId} is ${w.state}; there is nothing to claim.` });
        }
        if (w.brief === undefined) {
          return yield* new LeadError({
            code: "invalid",
            message: `${workstreamId} has no frozen brief, so it has no done-when checks to run.`,
            fix: `Register its brief with \`fleetd brief create --workstream ${workstreamId} --json '<Brief>'\` first.`,
          });
        }
        const at = yield* nowIso;
        const claimId = yield* records.start(workstreamId, w.projectRef);
        const verifying: Workstream = { ...w, state: "verifying", updatedAt: at };
        if (w.state !== "verifying") {
          yield* leadRecords.workstreams.put({ ...stored, workstream: verifying });
          yield* emit(w, "workstream.state", `${workstreamId} is verifying (${claimId})`, { workstreamId, state: "verifying", claimId });
        }
        // Run interrupts the claim this one supersedes.
        const fiber = yield* FiberMap.run(running, workstreamId, runClaim(verifying, claimId, by, at));
        return { claimId, fiber };
      }).pipe(lock.withPermit);

    const claimDone: Claims["Service"]["claimDone"] = (workstreamId, by, opts = {}) =>
      Effect.gen(function* () {
        const { claimId, fiber } = yield* start(workstreamId, by, opts.projectRef);
        const inline = yield* Fiber.await(fiber).pipe(Effect.timeoutOption(inlineWait));
        if (inline._tag === "Some" && Exit.isSuccess(inline.value)) {
          const claim = inline.value.value;
          // As stored: a workstream stopped while its checks ran stays stopped.
          const state = (yield* leadRecords.workstreams.get(workstreamId))?.workstream.state ?? "verifying";
          const failing = claim.results.filter((r) => r.result !== "pass").map((r) => `done:${r.checkIndex}`);
          return claim.outcome === "pass"
            ? { claimId, workstreamId, state, claim, next: `${workstreamId} is ${state}: every check passed. Spawn nothing more for it.` }
            : {
                claimId,
                workstreamId,
                state,
                claim,
                next: `${failing.join(", ")} did not pass; the evidence is in each result. Fix what failed, then claim again.`,
              };
        }
        if (inline._tag === "Some") {
          // Superseded by a newer claim before it finished.
          return { claimId, workstreamId, state: "verifying", next: `${claimId} was superseded by a newer claim on ${workstreamId}.` };
        }
        // Still running: a failure wakes the lead anyway; a pass needs telling, since this call has returned.
        yield* Fiber.await(fiber).pipe(
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit) && exit.value.outcome === "pass"
              ? Effect.flatMap(leadRecords.workstreams.get(workstreamId), (s) =>
                  s?.workstream.state === "done" ? wakes.trigger(s.workstream.projectRef, { kind: "claim_passed", claimId, workstreamId }) : Effect.void,
                )
              : Effect.void,
          ),
          Effect.forkIn(scope),
        );
        return {
          claimId,
          workstreamId,
          state: "verifying",
          next: `${claimId} is still running its checks (a judge, the human, or a slow command); its outcome arrives in a wake. Carry on with other work.`,
        };
      });

    return Claims.of({ claimDone, get: records.get, list: records.list });
  });

/** Needs ClaimRecords, LeadRecords, CheckRunner, EventLog, LeadWakes, Estimates and Incidents. */
export const layer = (options: ClaimsOptions = {}) => Layer.effect(Claims, make(options));
