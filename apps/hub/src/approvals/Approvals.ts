// Secrets, approvals and checklists (M8): the asks only a person answers, where the hub acts on the answer.
// - secret: the desktop app seals the value to the sink machine's box key; the hub relays the ciphertext to that node
//   without storing it and keeps only the fingerprint the node reports.
// - approve: `fleetd gated run` stores the exact command; once a human answers "go", the project's node runs those
//   bytes and the exit code and output tail go to the lead as evidence.
// - do with verify: once ticked done, the hub runs the check; a failure reopens the ask with the evidence.
import {
  type AgentKeyInfo,
  type Ask,
  type AskId,
  DecisionKey,
  type GatedRunCall as GatedRunCallSchema,
  type GatedRunResult as GatedRunResultSchema,
  type GatedRunSpec,
  type HubEvent,
  type McpToolError,
  parseSecretSink,
  type ProjectRef,
  type SecretSubmitInput as SecretSubmitInputSchema,
  type SecretSubmitOutput as SecretSubmitOutputSchema,
  type WorkstreamId,
} from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Auth from "../auth/Auth.ts";
import { CheckRunner } from "../checks/CheckRunner.ts";
import { NodeCommands } from "../checks/NodeCommands.ts";
import { LeadWakes } from "../leads/LeadWakes.ts";
import { Asks } from "../ledger/Asks.ts";
import { isoAt } from "../ledger/LedgerRepo.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";

type SecretSubmitInput = typeof SecretSubmitInputSchema.Type;
type SecretSubmitOutput = typeof SecretSubmitOutputSchema.Type;
type GatedRunCall = typeof GatedRunCallSchema.Type;
type GatedRunResult = typeof GatedRunResultSchema.Type;

/** A refusal in the tools' `{ code, message, fix }` shape. */
export class ApprovalRefused extends Data.TaggedError("ApprovalRefused")<McpToolError> {}

const EVIDENCE_MAX = 2000;
/** Evidence while an approved command runs; replaced by its result. */
const RUNNING = "running on";
/** How runApproved's recorded outcomes start: exit code, timeout, or the node's refusal. */
const FINISHED = /^(exit |killed after |not run on )/u;
export const NOT_RUN_AFTER_RESTART = "not run: hub restarted before execution; answer again to run";

const HUMAN_ONLY_SECRET_FIX =
  "Enter it from the fleetd desktop app or another client with a --human key; agent keys never handle secret values.";

export class Approvals extends Context.Service<
  Approvals,
  {
    /** `secret_submit`: relays the sealed value to the sink's node and closes the ask with the node's fingerprint. */
    readonly submitSecret: (caller: AgentKeyInfo, input: SecretSubmitInput) => Effect.Effect<SecretSubmitOutput, ApprovalRefused>;
    /** `fleetd gated run`: files the approve ask holding exactly this command, run in the project workspace by default. */
    readonly gatedRun: (
      projectRef: ProjectRef,
      by: string,
      call: Omit<GatedRunCall, "op" | "workstreamId"> & { readonly workstreamId?: WorkstreamId },
    ) => Effect.Effect<GatedRunResult, ApprovalRefused>;
  }
>()("fleetd/approvals/Approvals") {}

const refuse = (code: McpToolError["code"], message: string, fix?: string) =>
  new ApprovalRefused({ code, message, ...(fix === undefined ? {} : { fix }) });

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** argv as one readable line: JSON quoting only for words that need it. */
export const shownArgv = (argv: ReadonlyArray<string>) => argv.map((word) => (/^[\w./:=@%+-]+$/u.test(word) ? word : JSON.stringify(word))).join(" ");

/** A header line, then as much of the output's end as fits. */
const withTail = (head: string, tail: string) => {
  const room = EVIDENCE_MAX - head.length - 1;
  const t = tail.trimEnd();
  if (t === "" || room <= 0) return head.slice(0, EVIDENCE_MAX);
  return `${head}\n${t.length <= room ? t : `…${t.slice(t.length - room + 1)}`}`;
};

const projectFields = (ref: ProjectRef | undefined) => (ref === undefined ? {} : { machineId: ref.machineId, projectId: ref.projectId });

/**
 * Hands each answer recorded from now on to `handle`, with the ask it answered, while that answer stands. Starting
 * at the head means an answer from before a hub restart is never acted on late, so a command never runs twice.
 */
const followAnswers = (handle: (ask: Ask) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const events = yield* EventLog.EventLog;
    const asks = yield* Asks;
    let cursor = yield* events.head();
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const page = yield* events.wait({ cursor, types: ["decision.recorded"], timeoutSec: 3600 });
          cursor = page.cursor;
          for (const event of page.events) {
            const data = event.data as { readonly askId?: AskId; readonly decisionId?: string } | undefined;
            if (data?.askId === undefined || data.decisionId === undefined) continue;
            const ask = yield* asks.get(data.askId);
            if (ask === undefined || ask.state !== "answered" || ask.decisionId !== data.decisionId) continue;
            yield* Effect.forkScoped(handle(ask));
          }
        }),
      ),
    );
  });

const make = Effect.gen(function* () {
  const asks = yield* Asks;
  const commands = yield* NodeCommands;
  const wakes = yield* LeadWakes;
  const events = yield* EventLog.EventLog;
  const store = yield* HubStore.HubStore;
  const auth = yield* Auth.Auth;

  const append = (event: Omit<HubEvent, "seq" | "at">) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => events.append({ at: isoAt(now), ...event }));

  const wakeWith = (ask: Ask, value: string) =>
    ask.projectRef === undefined ? Effect.void : wakes.trigger(ask.projectRef, { kind: "answer", answer: { ask, outcome: "answered", value } });

  const submitSecret: Approvals["Service"]["submitSecret"] = (caller, input) =>
    Effect.gen(function* () {
      if (caller.kind !== "human") return yield* refuse("forbidden", "Only a person enters secrets.", HUMAN_ONLY_SECRET_FIX);
      const ask = yield* asks.get(input.askId);
      const sink = ask?.sink === undefined ? undefined : parseSecretSink(ask.sink);
      if (ask === undefined || ask.kind !== "secret" || sink === undefined) {
        return yield* refuse("not_found", `No secret ask ${input.askId}.`, "Use the askId of an open secret ask from asks_list.");
      }
      for (const machineId of new Set([sink.machineId, ...(ask.projectRef === undefined ? [] : [ask.projectRef.machineId])])) {
        if (!auth.allows(caller, "operate", machineId)) {
          return yield* refuse("forbidden", `This key has no operate grant on machine ${machineId}.`, "Use a human key with an operate grant there.");
        }
      }
      if (ask.state !== "open") return yield* refuse("invalid", `${ask.askId} is already ${ask.state}.`, "Nothing to enter: it is settled.");
      const machine = yield* store.machines.get(sink.machineId);
      if (machine === undefined) {
        return yield* refuse("not_found", `No machine ${sink.machineId}.`, "Ask the lead to file the secret ask with a sink on a known machine.");
      }
      if (machine.boxPubKey === undefined) {
        return yield* refuse("invalid", `${sink.machineId}'s node takes no secrets: it publishes no box key.`, `Update fleetd on ${sink.machineId} and restart its node.`);
      }
      const delivered = yield* commands
        .deliverSecret(sink.machineId, {
          sink: ask.sink!,
          sealed: input.sealed,
          secretKey: ask.key,
          ...(ask.envName === undefined ? {} : { envName: ask.envName }),
        })
        .pipe(
          // The ciphertext is never queued: the human enters it again once the node is back.
          Effect.mapError((error) =>
            refuse("machine_offline", `${sink.machineId}'s node did not take the secret: ${error.message}.`, `Try again when ${sink.machineId} is online.`),
          ),
        );
      if (delivered.fingerprint === undefined) {
        return yield* refuse(
          "invalid",
          `${sink.machineId}'s node could not save it: ${delivered.error ?? "no reason given"}.`,
          "Seal it to the machine's current boxPubKey and try again, or ask the lead to fix the sink.",
        );
      }
      const fingerprint = delivered.fingerprint;
      const by = `human:${caller.name}`;
      const now = yield* Clock.currentTimeMillis;
      const saved = yield* asks
        .update(ask.askId, (current) => ({
          ...current,
          state: "answered",
          fingerprint,
          evidence: `fingerprint ${fingerprint}`,
          answer: { value: `saved, fingerprint ${fingerprint}`, by, at: isoAt(now), raw: "secret_submit" },
        }))
        .pipe(Effect.mapError((error) => refuse(error.code, error.message)));
      yield* append({
        type: "ask.secret_saved",
        ...projectFields(ask.projectRef),
        summary: `${ask.askId} ${ask.key} saved on ${sink.machineId}, fingerprint ${fingerprint}`,
        data: { askId: ask.askId, fingerprint, by },
      });
      yield* wakeWith(saved, `saved to its ${sink.kind} sink on ${sink.machineId}, fingerprint ${fingerprint}`);
      return { askId: ask.askId, fingerprint, next: `Saved on ${sink.machineId}; the lead hears it in its next wake.` };
    });

  const gatedRun: Approvals["Service"]["gatedRun"] = (projectRef, by, call) =>
    Effect.gen(function* () {
      const project = yield* store.projects.get(projectRef);
      if (project === undefined) {
        return yield* refuse("not_found", `The hub has no record of project ${projectRef.projectId} on ${projectRef.machineId}.`, "Check fleetd_status, then run it again.");
      }
      const gated: GatedRunSpec = {
        argv: call.argv,
        // Stored resolved, so the human approves the exact directory too.
        cwd: call.cwd ?? project.workspaceRoot,
        class: call.class,
        reason: call.reason,
        ...(call.secretEnv === undefined ? {} : { secretEnv: call.secretEnv }),
        timeoutSec: call.timeoutSec,
      };
      const outcome = yield* asks
        .create(
          {
            projectRef,
            ...(call.workstreamId === undefined ? {} : { workstreamId: call.workstreamId }),
            kind: "approve",
            // Replaced by gated.<askId> once the ask has its id.
            key: DecisionKey.make("gated.new"),
            class: call.class,
            text: clip(`Run ${shownArgv(call.argv)} on ${projectRef.machineId} in ${gated.cwd}: ${call.reason}`, 500),
            gated,
            // Irreversible and money steps hold the lead back, so they are loud; a credential command is not.
            blocks: call.class === "credential" ? "nothing" : clip(`the lead's ${call.class} step: ${call.reason}`, 200),
            proceededOnRec: false,
          },
          by,
        )
        .pipe(Effect.mapError((error) => refuse(error.code, error.message, error.fix)));
      return {
        op: "gated_run",
        askId: outcome.ask.askId,
        state: outcome.ask.state,
        next: "carry on with other work: the human approves or refuses it, and the exit code and output tail arrive in a wake.",
      } satisfies GatedRunResult;
    });

  /** Runs an approve ask's stored command on its project's node after a human answered "go". */
  const runApproved = (ask: Ask) =>
    Effect.gen(function* () {
      const spec = ask.gated;
      const ref = ask.projectRef;
      if (spec === undefined || ref === undefined || ask.answer?.value !== "go") return;
      const machineId = ref.machineId;
      const by = ask.answer.by;
      const cwd = spec.cwd ?? (yield* store.projects.get(ref))?.workspaceRoot;
      // Marks it in flight, so a hub restart before the result arrives is reported as "result unknown", not "not run".
      yield* asks.update(ask.askId, (current) => ({ ...current, evidence: `${RUNNING} ${machineId}, approved by ${by}` })).pipe(Effect.ignore);
      const ran = yield* Effect.result(
        cwd === undefined
          ? Effect.succeed({ exitCode: null, outputTail: "", timedOut: false, error: "the project has no workspace on record" })
          : commands.runGated(machineId, {
              askId: ask.askId,
              argv: spec.argv,
              cwd,
              timeoutSec: spec.timeoutSec,
              ...(spec.secretEnv === undefined ? {} : { secretEnv: spec.secretEnv }),
            }),
      );
      if (ran._tag === "Failure" && ran.failure.reason === "offline") {
        // Nothing ran, so the human can approve it again once the machine is back.
        yield* asks.reopen(ask.askId, `not run: ${machineId}'s node was offline when ${by} approved it; answer go again once it is online`).pipe(Effect.ignore);
        return;
      }
      const outcome = ran._tag === "Success" ? ran.success : undefined;
      const evidence =
        outcome === undefined
          ? `result unknown: ${ran._tag === "Failure" ? ran.failure.message : ""}; check on ${machineId} whether it ran before approving it again`
          : outcome.error !== undefined
            ? `not run on ${machineId}: ${outcome.error}`
            : withTail(
                `${outcome.timedOut ? `killed after ${spec.timeoutSec} s` : `exit ${outcome.exitCode ?? "none (ended by a signal)"}`} on ${machineId}, approved by ${by}`,
                outcome.outputTail,
              );
      // A link that dropped mid-run leaves the result unknown: back to the human, loud, to check before approving again.
      const done =
        outcome === undefined
          ? yield* asks.reopen(ask.askId, evidence).pipe(Effect.orElseSucceed(() => ({ ...ask, evidence })))
          : yield* asks.update(ask.askId, (current) => ({ ...current, evidence })).pipe(Effect.orElseSucceed(() => ({ ...ask, evidence })));
      yield* append({
        type: "gated.ran",
        ...projectFields(ref),
        summary: clip(`${ask.askId} ${evidence.split("\n")[0]}`, 200),
        data: {
          askId: ask.askId,
          exitCode: outcome?.exitCode ?? null,
          timedOut: outcome?.timedOut ?? false,
          by,
          ...(outcome !== undefined && outcome.error === undefined ? {} : { ran: false }),
        },
      });
      yield* wakeWith(done, "go");
    });

  // An approval the hub accepted but never finished before it stopped: never run late, but never silently lost.
  for (const ask of yield* asks.list({ state: "answered", limit: Number.MAX_SAFE_INTEGER })) {
    if (ask.kind !== "approve" || ask.answer?.value !== "go") continue;
    const evidence = ask.evidence ?? "";
    if (FINISHED.test(evidence)) continue;
    const machineId = ask.projectRef?.machineId ?? "its machine";
    // Anything else is evidence from before this "go" (an earlier reopen) or none: it never started.
    const why = evidence.startsWith(RUNNING)
      ? `result unknown: the hub restarted while it ran on ${machineId}; check on ${machineId} whether it ran before approving it again`
      : NOT_RUN_AFTER_RESTART;
    yield* asks.reopen(ask.askId, why).pipe(Effect.ignore);
  }

  yield* followAnswers((ask) => (ask.kind === "approve" ? runApproved(ask) : Effect.void));

  return Approvals.of({ submitSecret, gatedRun });
});

/** Needs Asks, NodeCommands, LeadWakes, EventLog, HubStore and Auth. */
export const layer = Layer.effect(Approvals, make);

/**
 * Re-checks a do ask with a verify check once the human ticks it done: a pass goes to the lead with the evidence, a
 * failure reopens the ask with it. Needs CheckRunner, Asks, LeadWakes and EventLog.
 */
export const layerChecklists = Layer.effectDiscard(
  Effect.gen(function* () {
    const checks = yield* CheckRunner;
    const asks = yield* Asks;
    const wakes = yield* LeadWakes;
    yield* followAnswers((ask) =>
      Effect.gen(function* () {
        const verify = ask.verify;
        const ref = ask.projectRef;
        if (ask.kind !== "do" || verify === undefined || ask.answer?.value !== "done" || ref === undefined) return;
        if (verify.type === "judge" || verify.type === "human") return;
        const checked = yield* checks.verify({ projectRef: ref, ...(ask.workstreamId === undefined ? {} : { workstreamId: ask.workstreamId }) }, verify);
        if (checked.result !== "pass") {
          const why = checked.result === "fail" ? "failed" : "could not run";
          yield* asks.reopen(ask.askId, clip(`ticked done, but its check ${why}: ${checked.evidence}`, EVIDENCE_MAX)).pipe(Effect.ignore);
          return;
        }
        const done = yield* asks
          .update(ask.askId, (current) => ({ ...current, evidence: clip(`verified: ${checked.evidence}`, EVIDENCE_MAX) }))
          .pipe(Effect.orElseSucceed(() => ask));
        yield* wakes.trigger(ref, { kind: "answer", answer: { ask: done, outcome: "answered", value: "done" } });
      }),
    );
  }),
);
