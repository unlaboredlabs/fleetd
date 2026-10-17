import {
  BatchId,
  DecisionKey,
  type Ask,
  type Decision,
  type InboxReplyApplied as InboxReplyAppliedSchema,
  type InboxReplyOutput as InboxReplyOutputSchema,
  type ProjectRef,
} from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EventLog from "../store/EventLog.ts";
import { recordedEvent } from "./Decisions.ts";
import { type Actor, LedgerError, LedgerRepo, batchN, invalid, isoAt, projectKey, write } from "./LedgerRepo.ts";
import { type Action, parseReply, resolvePlan } from "./ReplyGrammar.ts";

/** One answered or withdrawn ask, as delivered to its project's lead. */
export interface Answer {
  /** The ask after the answer was applied. */
  readonly ask: Ask;
  readonly outcome: "answered" | "withdrawn";
  /** The answer value; absent for a withdrawal. */
  readonly value?: string;
  readonly decision?: Decision;
}

/**
 * Where applied answers go: the lead-wake code (M3b) provides this to wake each project's lead with its answers
 * inline. Called once per project per reply, after the reply is committed.
 */
export class AnswerSink extends Context.Service<
  AnswerSink,
  { readonly onAnswered: (projectRef: ProjectRef, answers: ReadonlyArray<Answer>) => Effect.Effect<void> }
>()("fleetd/ledger/AnswerSink") {}

/** Drops answers; for tests and until the lead-wake code is wired. */
export const layerAnswerSinkNoop = Layer.succeed(AnswerSink, AnswerSink.of({ onAnswered: () => Effect.void }));

export interface ReplyInput {
  readonly raw: string;
  readonly batchId?: BatchId;
  /**
   * The caller's grants: whether it may write in a project, or globally when `projectRef` is absent ("pref:" and
   * "forget"). A reply touching anything it may not write changes nothing. Absent: everything is allowed.
   */
  readonly allows?: (projectRef?: ProjectRef) => boolean;
}

/** `inbox_reply`: applies a terse human reply to a batch. */
export class Inbox extends Context.Service<
  Inbox,
  { readonly reply: (input: ReplyInput, actor: Actor) => Effect.Effect<InboxReplyOutput> }
>()("fleetd/ledger/Inbox") {}

type InboxReplyOutput = typeof InboxReplyOutputSchema.Type;
type InboxReplyApplied = typeof InboxReplyAppliedSchema.Type;

const PREF_SLUG_MAX = 75;

/** `pref.<slug>` from the preference text, so restating a preference supersedes it. */
export const prefKey = (text: string): DecisionKey => {
  let slug = "";
  for (const word of text.toLowerCase().match(/[a-z0-9]+/gu) ?? []) {
    const next = slug === "" ? word : `${slug}-${word}`;
    if (next.length > PREF_SLUG_MAX) break;
    slug = next;
  }
  if (slug === "") {
    // Text with no latin letters or digits: a stable hash keeps the key valid and repeatable.
    let hash = 0x811c9dc5;
    for (const char of text) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0;
    slug = `p${hash.toString(16)}`;
  }
  return DecisionKey.make(`pref.${slug}`);
};

const short = (value: string) => (value.length > 40 ? `${value.slice(0, 39)}…` : value);

interface Applied {
  readonly batchId?: BatchId;
  readonly applied: ReadonlyArray<InboxReplyApplied>;
  readonly echo: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<{ readonly decision: Decision; readonly projectRef?: ProjectRef }>;
  readonly answers: ReadonlyArray<Answer>;
}

const make = Effect.gen(function* () {
  const repo = yield* LedgerRepo;
  const events = yield* EventLog.EventLog;
  const sink = yield* AnswerSink;

  const apply = (input: ReplyInput, actor: Actor, nowMs: number) =>
    write(repo, (): Applied => {
      const parsed = parseReply(input.raw);
      if (!parsed.parsed) throw invalid(parsed.hint);
      const { plan } = parsed;
      if ((plan.prefs.length > 0 || plan.forgets.length > 0) && input.allows?.() === false) {
        throw new LedgerError({
          code: "forbidden",
          message: '"pref:" and "forget" change decisions for every machine, and this caller may not write on all of them.',
          fix: "Use a key with an operate grant on all machines (*).",
        });
      }
      if (plan.batch !== undefined && input.batchId !== undefined && batchN(input.batchId) !== plan.batch) {
        throw invalid(`The reply names B${plan.batch} but the request names ${input.batchId}.`);
      }
      const applied: Array<InboxReplyApplied> = [];
      const echo: Array<string> = [];
      const decisions: Array<{ decision: Decision; projectRef?: ProjectRef }> = [];
      const answers: Array<Answer> = [];
      const by = { source: actor.source, by: actor.by };
      const answerOf = (value: string) => ({ value, by: actor.by, at: isoAt(nowMs), raw: input.raw });

      let batchId: BatchId | undefined;
      if (plan.items.length > 0 || plan.rest !== undefined) {
        const wanted = plan.batch ?? (input.batchId === undefined ? undefined : batchN(input.batchId));
        const stored = wanted === undefined ? repo.latestOpenBatch() : repo.getBatch(wanted);
        if (!stored) throw invalid(wanted === undefined ? "There is no open batch to answer." : `There is no batch B${wanted}.`);
        if (stored.batch.state === "closed") throw invalid(`${stored.batch.batchId} is closed; every item in it is handled.`);
        batchId = stored.batch.batchId;
        const items = stored.batch.items.map((item) => ({ number: item.number, ask: repo.getAskRow(item.askId)!.ask }));
        const resolved = resolvePlan(plan, batchId, items);
        if (!resolved.ok) throw invalid(resolved.hint);
        const actions = [...resolved.actions].sort((a, b) => a.number - b.number);
        const denied = actions.find((action) => input.allows?.(action.ask.projectRef) === false);
        if (denied) {
          throw new LedgerError({
            code: "forbidden",
            message: `Item ${denied.number} is about ${projectKey(denied.ask.projectRef)}, where this caller may not answer.`,
            fix: "Answer only the items of your own machines, or ask the hub admin for an operate grant there.",
          });
        }
        for (const action of actions) applyAction(action, stored.n);
        repo.closeIfDone(stored.n);
      }

      function applyAction(action: Action, fromBatch: number) {
        const { ask, number } = action;
        switch (action.kind) {
          case "answer": {
            const decision = repo.recordDecision(
              {
                key: ask.key,
                scope: { kind: "project", projectRef: ask.projectRef },
                value: action.value,
                ...(action.note === undefined ? {} : { why: action.note }),
                askId: ask.askId,
              },
              actor,
              nowMs,
            );
            const answered: Ask = { ...ask, state: "answered", answer: answerOf(action.value), decisionId: decision.decisionId };
            repo.putAsk(answered);
            decisions.push({ decision });
            answers.push({ ask: answered, outcome: "answered", value: action.value, decision });
            applied.push({ number, askId: ask.askId, outcome: "answered", value: action.value, decisionId: decision.decisionId, ...by });
            echo.push(`${number} → ${short(action.value)} (${decision.decisionId})`);
            return;
          }
          case "withdraw": {
            const withdrawn: Ask = { ...ask, state: "withdrawn", answer: answerOf("dropped") };
            repo.putAsk(withdrawn);
            const row = repo.getAskRow(ask.askId);
            // The lead filed a product call the human hands back: a misfiled ask, counted in M12.
            if (row?.filedBy.startsWith("lead:")) repo.recordIncident(ask, "misfiled", nowMs);
            answers.push({ ask: withdrawn, outcome: "withdrawn" });
            applied.push({ number, askId: ask.askId, outcome: "withdrawn", ...by });
            echo.push(`${number} → dropped`);
            return;
          }
          case "later": {
            const moved = repo.moveToLaterBatch(ask, fromBatch, nowMs);
            applied.push({ number, askId: ask.askId, outcome: "later", ...by });
            echo.push(`${number} → later (${moved.batchId}#${moved.number})`);
            return;
          }
        }
      }

      for (const n of plan.forgets) {
        const retired = repo.retireDecision(`D${n}`);
        applied.push({ outcome: "retired", decisionId: retired.decisionId, ...by });
        echo.push(`${retired.decisionId} → forgotten`);
      }
      for (const text of plan.prefs) {
        const decision = repo.recordDecision({ key: prefKey(text), scope: { kind: "global" }, value: text }, actor, nowMs);
        decisions.push({ decision });
        applied.push({ outcome: "pref", value: text, decisionId: decision.decisionId, ...by });
        echo.push(`${decision.key} → ${decision.decisionId}`);
      }
      return { ...(batchId === undefined ? {} : { batchId }), applied, echo, decisions, answers };
    });

  const reply = (input: ReplyInput, actor: Actor) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* Effect.result(apply(input, actor, now));
      if (result._tag === "Failure") {
        const error = result.failure;
        const hint = error.fix === undefined ? error.message : `${error.message} ${error.fix}`;
        return { parsed: false, applied: [], hint } satisfies InboxReplyOutput;
      }
      const done = result.success;
      for (const { decision, projectRef } of done.decisions) yield* events.append(recordedEvent(decision, projectRef));
      const byProject = new Map<string, { projectRef: ProjectRef; answers: Array<Answer> }>();
      for (const answer of done.answers) {
        const key = projectKey(answer.ask.projectRef);
        const group = byProject.get(key) ?? { projectRef: answer.ask.projectRef, answers: [] };
        group.answers.push(answer);
        byProject.set(key, group);
      }
      for (const group of byProject.values()) yield* sink.onAnswered(group.projectRef, group.answers);
      return {
        parsed: true,
        ...(done.batchId === undefined ? {} : { batchId: done.batchId }),
        echo: done.echo.length === 0 ? "Nothing to log: no open item needed an answer." : `Logged: ${done.echo.join(", ")}`,
        applied: done.applied,
      } satisfies InboxReplyOutput;
    });

  return Inbox.of({ reply });
});

export const layer = Layer.effect(Inbox, make);
