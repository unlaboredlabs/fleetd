import {
  AskClass,
  StepCommand,
  type Ask,
  type AskId,
  type AskKind,
  type AskState,
  type Batch,
  type BatchId,
  type Decision,
  type DecisionId,
  type DecisionKey,
  type HubEvent,
  type ProjectRef,
  type Step,
  type WorkstreamId,
} from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as EventLog from "../store/EventLog.ts";
import {
  type LedgerError,
  LedgerRepo,
  type StoredBatch,
  batchN,
  invalid,
  isoAt,
  notFound,
  projectKey,
  write,
} from "./LedgerRepo.ts";

/** A batch is published once this long passes with no new ask. */
export const QUIET_WINDOW_MS = 30_000;

/** The fix text for a question the lead must decide itself. */
export const DECIDE_YOURSELF = "decide this yourself and log it with `fleetd decide`";

/** What the lead files with `fleetd ask`; `class` is unchecked so the refusal can name the fix. */
export interface AskInput {
  readonly projectRef: ProjectRef;
  readonly workstreamId?: WorkstreamId;
  readonly kind: AskKind;
  readonly key: DecisionKey;
  readonly class: string;
  readonly text: string;
  readonly recommendation?: string;
  readonly options?: ReadonlyArray<string>;
  readonly steps?: ReadonlyArray<Step>;
  readonly blocks: string;
  readonly proceededOnRec: boolean;
}

export interface AskOutcome {
  /** "auto": answered from the log by `decision`, never batched. "open": new, or `attached` to an open one. */
  readonly state: "auto" | "open";
  readonly ask: Ask;
  readonly decision?: Decision;
  readonly attached?: boolean;
  /** Decisions that may already answer it, best first (new asks only). */
  readonly candidates?: ReadonlyArray<Decision>;
}

export interface AskFilter {
  readonly state?: AskState;
  readonly projectRef?: ProjectRef;
  readonly workstreamId?: WorkstreamId;
  readonly batchId?: BatchId;
  readonly limit?: number;
}

export class Asks extends Context.Service<
  Asks,
  {
    /** The ask path: filter, key auto-resolve, dedupe, create with candidates, then batch. `by` is the filer. */
    readonly create: (input: AskInput, by: string) => Effect.Effect<AskOutcome, LedgerError>;
    /** `fleetd ask withdraw A7 [--use D3]`. With `projectRef`, refuses asks of other projects. */
    readonly withdraw: (
      askId: AskId,
      options?: { readonly use?: DecisionId; readonly projectRef?: ProjectRef },
    ) => Effect.Effect<Ask, LedgerError>;
    readonly get: (askId: AskId) => Effect.Effect<Ask | undefined>;
    /** By batch, then number; asks outside any batch last. */
    readonly list: (filter: AskFilter) => Effect.Effect<ReadonlyArray<Ask>>;
    /** Newest first. */
    readonly batches: (filter?: {
      readonly state?: Batch["state"];
      readonly batchId?: BatchId;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<Batch>>;
  }
>()("fleetd/ledger/Asks") {}

const isAskClass = Schema.is(AskClass);
const isStepCommand = Schema.is(StepCommand);

/** Step 1 of the ask path. */
export const validateAsk = (input: AskInput): LedgerError | undefined => {
  if (!isAskClass(input.class)) {
    return invalid(
      `"${input.class}" is not something fleetd asks the human about (only product, money, credential, irreversible): ${DECIDE_YOURSELF}.`,
      `Run \`fleetd decide --key ${input.key} --value <your choice> --why <reason>\` and carry on.`,
    );
  }
  if (input.kind === "decide" && (input.recommendation === undefined || input.recommendation.trim() === "")) {
    return invalid("A decide ask needs a recommendation.", "Add --rec with what you would choose.");
  }
  if (input.kind === "do") {
    if (input.steps === undefined || input.steps.length === 0) {
      return invalid("A do ask needs at least one step.", "List the exact steps the human runs.");
    }
    const bad = input.steps.findIndex((step) => step.command !== undefined && !isStepCommand(step.command));
    if (bad >= 0) {
      return invalid(
        `Step ${bad + 1}'s command has a <placeholder>.`,
        "Write the real value, or make getting it a separate step.",
      );
    }
  }
  return undefined;
};

/** Money, credential and irreversible asks that hold a step back skip the quiet window. */
const isUrgent = (ask: Ask) => ask.class !== "product" && ask.blocks !== "nothing";

const projectFields = (ref: ProjectRef) => ({ machineId: ref.machineId, projectId: ref.projectId });

export const batchReadyEvent = (stored: StoredBatch, nowMs: number): Omit<HubEvent, "seq"> => ({
  at: isoAt(nowMs),
  type: "batch.ready",
  summary: `${stored.batch.batchId} ready: ${stored.batch.items.length} question${stored.batch.items.length === 1 ? "" : "s"}`,
  data: { batchId: stored.batch.batchId, items: stored.batch.items },
});

const make = Effect.gen(function* () {
  const repo = yield* LedgerRepo;
  const events = yield* EventLog.EventLog;
  const timer = yield* FiberHandle.make<void, never>();

  const publishDue = (n: number) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const published = yield* Effect.sync(() => {
        const stored = repo.getBatch(n);
        if (!stored || stored.batch.state !== "open" || stored.lastAddMs === undefined) return undefined;
        if (now - stored.lastAddMs < QUIET_WINDOW_MS) return undefined;
        return repo.publishBatch(n, now) ? stored : undefined;
      });
      if (published) yield* events.append(batchReadyEvent(published, now));
    });

  const schedule = (n: number, delayMs: number) =>
    FiberHandle.run(timer, Effect.sleep(Duration.millis(Math.max(0, delayMs))).pipe(Effect.andThen(publishDue(n)))).pipe(
      Effect.asVoid,
    );

  // A batch still collecting when the hub stopped publishes on its original schedule.
  const pending = repo.collectingBatch();
  if (pending?.lastAddMs !== undefined) {
    yield* schedule(pending.n, pending.lastAddMs + QUIET_WINDOW_MS - (yield* Clock.currentTimeMillis));
  }

  type Created =
    | { readonly tag: "auto"; readonly ask: Ask; readonly decision: Decision }
    | { readonly tag: "attached"; readonly ask: Ask }
    | {
        readonly tag: "new";
        readonly ask: Ask;
        readonly candidates: ReadonlyArray<Decision>;
        readonly batch: StoredBatch;
        readonly publishedNow: boolean;
      };

  const create = (input: AskInput, by: string) =>
    Effect.gen(function* () {
      const refused = validateAsk(input);
      if (refused) return yield* refused;
      const now = yield* Clock.currentTimeMillis;
      const chain = { projectRef: input.projectRef, ...(input.workstreamId ? { workstreamId: input.workstreamId } : {}) };
      const created = yield* write(repo, (): Created => {
        const base = (askId: AskId, state: AskState): Ask => ({
          askId,
          projectRef: input.projectRef,
          ...(input.workstreamId ? { workstreamId: input.workstreamId } : {}),
          kind: input.kind,
          key: input.key,
          class: input.class as AskClass,
          text: input.text,
          ...(input.options ? { options: input.options } : {}),
          ...(input.recommendation === undefined ? {} : { recommendation: input.recommendation }),
          ...(input.steps ? { steps: input.steps } : {}),
          blocks: input.blocks,
          proceededOnRec: input.proceededOnRec,
          state,
          createdAt: isoAt(now),
        });
        const decision = repo.resolve(input.key, chain);
        if (decision) {
          const ask = repo.insertAsk(input.projectRef, input.key, input.workstreamId, by, now, (askId) => ({
            ...base(askId, "auto"),
            decisionId: decision.decisionId,
          }));
          return { tag: "auto", ask, decision };
        }
        const existing = repo.openAskWithKey(input.projectRef, input.key);
        if (existing) return { tag: "attached", ask: existing };
        const fresh = repo.insertAsk(input.projectRef, input.key, input.workstreamId, by, now, (askId) => base(askId, "open"));
        const { ask, batch } = repo.addToCollecting(fresh, now);
        const publishedNow = isUrgent(ask) && repo.publishBatch(batch.n, now);
        const candidates = repo.searchDecisions(`${input.key} ${input.text}`, { chain, limit: 5 });
        return { tag: "new", ask, candidates, batch: repo.getBatch(batch.n)!, publishedNow };
      });

      switch (created.tag) {
        case "auto": {
          yield* events.append({
            at: isoAt(now),
            type: "ask.auto",
            ...projectFields(input.projectRef),
            summary: `${created.ask.askId} ${input.key} answered from ${created.decision.decisionId}: ${created.decision.value}`,
            data: { askId: created.ask.askId, key: input.key, decisionId: created.decision.decisionId },
          });
          return { state: "auto", ask: created.ask, decision: created.decision } satisfies AskOutcome;
        }
        case "attached":
          return { state: "open", ask: created.ask, attached: true } satisfies AskOutcome;
        case "new": {
          const { ask } = created;
          yield* events.append({
            at: isoAt(now),
            type: "ask.created",
            ...projectFields(input.projectRef),
            summary: `${ask.askId} [${ask.class}] ${ask.key}: ${ask.text}`,
            data: { askId: ask.askId, key: ask.key, class: ask.class, batchId: ask.batchId, number: ask.number },
          });
          if (created.publishedNow) {
            yield* FiberHandle.clear(timer);
            yield* events.append(batchReadyEvent(created.batch, now));
          } else {
            yield* schedule(created.batch.n, QUIET_WINDOW_MS);
          }
          return { state: "open", ask, candidates: created.candidates } satisfies AskOutcome;
        }
      }
    });

  const withdraw = (askId: AskId, options: { readonly use?: DecisionId; readonly projectRef?: ProjectRef } = {}) =>
    write(repo, () => {
      const row = repo.getAskRow(askId);
      if (!row || (options.projectRef && projectKey(options.projectRef) !== projectKey(row.ask.projectRef))) {
        throw notFound(`No ask ${askId} in this project.`);
      }
      if (row.ask.state !== "open") throw invalid(`${askId} is already ${row.ask.state}.`);
      if (options.use !== undefined) {
        const decision = repo.getDecision(options.use);
        if (!decision || decision.state !== "active") throw notFound(`No active decision ${options.use}.`);
      }
      const withdrawn: Ask = {
        ...row.ask,
        state: "withdrawn",
        ...(options.use === undefined ? {} : { decisionId: options.use }),
      };
      repo.putAsk(withdrawn);
      if (withdrawn.batchId) repo.closeIfDone(batchN(withdrawn.batchId)!);
      return withdrawn;
    });

  return Asks.of({
    create,
    withdraw,
    get: (askId) => Effect.sync(() => repo.getAskRow(askId)?.ask),
    list: (filter) => Effect.sync(() => repo.listAsks(filter)),
    batches: (filter = {}) =>
      Effect.sync(() => {
        if (filter.batchId !== undefined) {
          const stored = repo.getBatch(batchN(filter.batchId)!);
          return stored && (filter.state === undefined || stored.batch.state === filter.state) ? [stored.batch] : [];
        }
        return repo.listBatches(filter).map((stored) => stored.batch);
      }),
  });
});

export const layer = Layer.effect(Asks, make);
