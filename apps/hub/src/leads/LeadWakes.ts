// Wakes to a lead: triggers for one lead are debounced and coalesced into a single message, which starts with
// the code-rendered digest and then says why the lead was woken.
import type { Decision, DecisionScope, ProjectRef, TaskId, TaskResult, ThreadRef, WorkstreamId } from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { Asks } from "../ledger/Asks.ts";
import { Decisions } from "../ledger/Decisions.ts";
import { type Answer, AnswerSink } from "../ledger/Inbox.ts";
import * as WriteQueue from "../queue/WriteQueue.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";
import { taskDigestLines, taskResultLines } from "../tasks/render.ts";
import * as TaskRecords from "../tasks/TaskRecords.ts";
import { renderLeadDigest } from "./digest.ts";
import * as LeadRecords from "./LeadRecords.ts";

export const WAKE_DEBOUNCE = Duration.seconds(10);
/** A steady trigger stream still wakes the lead this long after the first pending trigger. */
export const WAKE_MAX_WAIT = Duration.seconds(60);

export type Trigger =
  | { readonly kind: "intent"; readonly workstreamId: WorkstreamId; readonly text: string }
  | { readonly kind: "answer"; readonly answer: Answer }
  /** A decision the human recorded that touches the lead's project. */
  | { readonly kind: "decision"; readonly decision: Decision }
  /** A task ended; its result goes into the wake inline. */
  | { readonly kind: "task_result"; readonly taskId: TaskId; readonly title: string; readonly result: TaskResult };

export class LeadWakes extends Context.Service<
  LeadWakes,
  {
    /** Queues a trigger; the lead is woken once no new trigger has arrived for WAKE_DEBOUNCE, or WAKE_MAX_WAIT after the first. */
    readonly trigger: (ref: ProjectRef, trigger: Trigger) => Effect.Effect<void>;
    /** The lead digest as of now, with `answers` as its "since your last wake" list. */
    readonly digest: (ref: ProjectRef, answers?: ReadonlyArray<Answer>) => Effect.Effect<string>;
  }
>()("fleetd/leads/LeadWakes") {}

const quote = (text: string) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
};

const scopeText = (scope: DecisionScope) => (scope.kind === "workstream" ? scope.workstreamId : scope.kind);

/** The "why you are woken" lines. Answers are already listed in the digest, so they get one summary line. */
export const triggerLines = (triggers: ReadonlyArray<Trigger>): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  for (const t of triggers) {
    if (t.kind === "intent") {
      lines.push(
        `- New intent ${t.workstreamId}: '${quote(t.text)}'. Register it with \`fleetd brief create --workstream ${t.workstreamId} --json '<Brief>'\`.`,
      );
    } else if (t.kind === "decision") {
      const d = t.decision;
      const who = d.source === "human" ? "The human" : `Agent ${d.by ?? "(unnamed)"}, for the human,`;
      lines.push(`- ${who} recorded ${d.decisionId}: ${d.key} = ${quote(d.value)} (${scopeText(d.scope)}). Follow it.`);
    } else if (t.kind === "task_result") {
      lines.push(taskResultLines(t));
    }
  }
  const answers = triggers.filter((t) => t.kind === "answer").length;
  if (answers > 0) lines.push(`- The human settled ${answers} of your asks; see "Answers since your last wake" above.`);
  return lines;
};

export const renderWake = (digest: string, triggers: ReadonlyArray<Trigger>) =>
  `${digest}\n\n## Why you are woken\n${triggerLines(triggers).join("\n")}`;

interface Pending {
  readonly ref: ProjectRef;
  readonly triggers: Array<Trigger>;
  /** Bumped by each trigger; only the timer started by the latest one flushes. */
  generation: number;
  /** When the first pending trigger arrived; the wake fires by `firstMs + maxWait` at the latest. */
  readonly firstMs: number;
}

const keyOf = (ref: ProjectRef) => `${ref.machineId}/${ref.projectId}`;

export interface LeadWakesOptions {
  readonly debounce?: Duration.Input;
  readonly maxWait?: Duration.Input;
}

export const make = (options: LeadWakesOptions = {}) =>
  Effect.gen(function* () {
    const records = yield* LeadRecords.LeadRecords;
    const asks = yield* Asks;
    const decisions = yield* Decisions;
    const store = yield* HubStore.HubStore;
    const events = yield* EventLog.EventLog;
    const queue = yield* WriteQueue.WriteQueue;
    const tasks = yield* TaskRecords.TaskRecords;
    const scope = yield* Effect.scope;
    const debounceMs = Duration.toMillis(Duration.fromInputUnsafe(options.debounce ?? WAKE_DEBOUNCE));
    const maxWaitMs = Duration.toMillis(Duration.fromInputUnsafe(options.maxWait ?? WAKE_MAX_WAIT));
    const pending = new Map<string, Pending>();
    const flushing = Semaphore.makeUnsafe(1);
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

    // Through the offline write queue, so a wake to an offline machine waits for it instead of being dropped.
    const deliver = (ref: ThreadRef, message: string, clientRequestId: string) => queue.send(ref, message, clientRequestId);

    const digest: LeadWakes["Service"]["digest"] = (ref, answers = []) =>
      Effect.gen(function* () {
        const project = yield* store.projects.get(ref);
        const workstreams = yield* records.workstreams.list({ ref, open: true, limit: 50 });
        const since = (yield* records.leads.get(ref))?.lastWakeAt;
        return renderLeadDigest({
          project: { ref, title: project?.title ?? ref.projectId },
          at: yield* nowIso,
          workstreams,
          openAsks: yield* asks.list({ state: "open", projectRef: ref, limit: 50 }),
          answers,
          // Global, project and every workstream-scoped decision in the project; the digest ranks them.
          decisions: yield* decisions.list({ chain: { projectRef: ref }, limit: 500 }),
          tasks: taskDigestLines(yield* tasks.forDigest(ref, since, 50), since),
        });
      });

    const flush = (p: Pending) =>
      Effect.gen(function* () {
        const triggers = [...p.triggers];
        const lead = yield* records.leads.get(p.ref);
        if (lead === undefined) {
          // No lead yet: lead_start's first message carries the digest, which shows the same state.
          yield* Effect.logInfo("lead wake dropped: project has no lead", { project: keyOf(p.ref), triggers: triggers.length });
          return;
        }
        const answers = triggers.flatMap((t) => (t.kind === "answer" ? [t.answer] : []));
        const message = renderWake(yield* digest(p.ref, answers), triggers);
        const at = yield* nowIso;
        const thread = { machineId: p.ref.machineId, threadId: lead.threadId };
        const sent = yield* Effect.result(deliver(thread, message, `fleetd-wake:${keyOf(p.ref)}:${lead.sessionGeneration}:${at}`));
        if (sent._tag === "Failure") {
          yield* Effect.logWarning("lead wake not delivered", { project: keyOf(p.ref), reason: sent.failure._tag });
          return;
        }
        yield* records.leads.put({ ...lead, lastWakeAt: at });
        yield* events.append({
          at,
          type: "lead.woken",
          machineId: p.ref.machineId,
          projectId: p.ref.projectId,
          threadId: lead.threadId,
          summary: `Lead of ${p.ref.projectId} ${sent.success.queued ? "wake queued" : "woken"} with ${triggers.length} trigger${triggers.length === 1 ? "" : "s"}`,
          data: { triggers: triggers.map((t) => t.kind), ...(sent.success.queued ? { queued: true } : {}) },
        });
      }).pipe(flushing.withPermit);

    // Timers are never interrupted: a superseded one wakes, sees a newer generation and does nothing. Taking the
    // entry out of `pending` is synchronous with that check, so a trigger lands either in this wake or the next.
    const trigger: LeadWakes["Service"]["trigger"] = (ref, t) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const key = keyOf(ref);
        let entry = pending.get(key);
        if (entry === undefined) {
          entry = { ref, triggers: [], generation: 0, firstMs: now };
          pending.set(key, entry);
        }
        entry.triggers.push(t);
        const p = entry;
        const generation = ++p.generation;
        // The quiet window, cut short so the latest timer never sleeps past the max-wait deadline.
        const delayMs = Math.max(0, Math.min(debounceMs, p.firstMs + maxWaitMs - now));
        return Effect.sleep(Duration.millis(delayMs)).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (pending.get(key) !== p || p.generation !== generation) return Effect.void;
              pending.delete(key);
              return flush(p);
            }),
          ),
          Effect.forkIn(scope),
          Effect.asVoid,
        );
      });

    return LeadWakes.of({ trigger, digest });
  });

export const layer = (options: LeadWakesOptions = {}) => Layer.effect(LeadWakes, make(options));

/** The ledger's AnswerSink: each applied answer becomes a trigger for its project's lead. */
export const layerAnswerSink = Layer.effect(
  AnswerSink,
  Effect.map(LeadWakes, (wakes) =>
    AnswerSink.of({
      onAnswered: (ref, answers) => Effect.forEach(answers, (answer) => wakes.trigger(ref, { kind: "answer", answer }), { discard: true }),
    }),
  ),
);

/**
 * Wakes a lead when someone other than a lead records a decision in its project (decisions_record from a human or
 * an outside agent). Answers to asks are left out: the AnswerSink already delivers those. Follows the event log
 * from the hub's start, so it sees every path that records a decision.
 */
export const layerDecisionWakes = Layer.effectDiscard(
  Effect.gen(function* () {
    const wakes = yield* LeadWakes;
    const decisions = yield* Decisions;
    const events = yield* EventLog.EventLog;
    let cursor = yield* events.head();
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const page = yield* events.wait({ cursor, types: ["decision.recorded"], timeoutSec: 3600 });
          cursor = page.cursor;
          for (const event of page.events) {
            if (event.machineId === undefined || event.projectId === undefined) continue;
            // A global decision touches every project; leads see it in their next digest instead.
            const id = (event.data as { readonly decisionId?: Decision["decisionId"] } | undefined)?.decisionId;
            const decision = id === undefined ? undefined : yield* decisions.get(id);
            if (decision === undefined || decision.scope.kind === "global" || decision.source === "lead" || decision.askId !== undefined) {
              continue;
            }
            yield* wakes.trigger({ machineId: event.machineId, projectId: event.projectId }, { kind: "decision", decision });
          }
        }),
      ),
    );
  }),
);
