import {
  AskClass,
  DecisionKey,
  StepCommand,
  UNROUTED_ASK_PREFIX,
  secretEnvName,
  type Ask,
  type CheckSpec,
  type GatedRunSpec,
  type AskId,
  type AskKind,
  type AskState,
  type Batch,
  type BatchId,
  type Decision,
  type DecisionId,
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
  askProjectKey,
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
  /** Absent only for an `intake.route.*` ask (the router's fallback). */
  readonly projectRef?: ProjectRef;
  readonly workstreamId?: WorkstreamId;
  readonly kind: AskKind;
  readonly key: DecisionKey;
  readonly class: string;
  readonly text: string;
  readonly recommendation?: string;
  readonly options?: ReadonlyArray<string>;
  readonly steps?: ReadonlyArray<Step>;
  /** do: re-checked once the human ticks it done. */
  readonly verify?: CheckSpec;
  /** secret: where the node writes it. */
  readonly sink?: string;
  readonly envName?: string;
  /** approve: the stored command; its key is always `gated.<askId>`. */
  readonly gated?: GatedRunSpec;
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
    /** Rewrites one ask in place (evidence, a saved secret's fingerprint) and closes its batch once nothing in it is open. */
    readonly update: (askId: AskId, change: (ask: Ask) => Ask) => Effect.Effect<Ask, LedgerError>;
    /**
     * Puts an answered ask back in front of the human with `evidence` saying why (a failed verify, a command that
     * never ran): its answer's decision is retired and it joins the collecting batch like a new ask.
     */
    readonly reopen: (askId: AskId, evidence: string) => Effect.Effect<Ask, LedgerError>;
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
  if (input.projectRef === undefined && !input.key.startsWith(UNROUTED_ASK_PREFIX)) {
    return invalid(`Only an ${UNROUTED_ASK_PREFIX}* ask may leave out its project.`, "Name the project the ask is about.");
  }
  if (!isAskClass(input.class)) {
    return invalid(
      `"${input.class}" is not something fleetd asks the human about (only product, money, credential, irreversible): ${DECIDE_YOURSELF}.`,
      `Run \`fleetd decide --key ${input.key} --value <your choice> --why <reason>\` and carry on.`,
    );
  }
  if (input.kind === "decide" && (input.recommendation === undefined || input.recommendation.trim() === "")) {
    return invalid("A decide ask needs a recommendation.", "Add --rec with what you would choose.");
  }
  if (input.kind === "secret") {
    if (input.sink === undefined) return invalid("A secret ask needs a sink.", "Add --sink env:<machine>:<path> or file:<machine>:<path>.");
    if (input.class === "product") return invalid("A secret is not a product call.", "File it with --class credential.");
    if (input.sink.startsWith("env:") && input.envName === undefined && secretEnvName(input.key) === undefined) {
      return invalid(`The key ${input.key} names no valid environment variable.`, "Add --env-name with the variable the env file should hold.");
    }
  }
  if (input.kind === "approve" && (input.gated === undefined || input.gated.class !== input.class)) {
    return invalid("An approve ask needs its stored command, with the same class.", "Use `fleetd gated run`.");
  }
  if (input.verify !== undefined && (input.kind !== "do" || input.verify.type === "judge" || input.verify.type === "human")) {
    return invalid(
      "Only a do ask has --verify, and it must be a check fleetd runs itself (cmd, http, pr_merged, ci_green or test).",
      "Drop --verify, or give a cmd or http check that shows the step is done.",
    );
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

const projectFields = (ref: ProjectRef | undefined) => (ref === undefined ? {} : { machineId: ref.machineId, projectId: ref.projectId });

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

  /** A new or reopened ask joins the collecting batch; an urgent one publishes it at once. Inside a write. */
  const placed = (fresh: Ask, candidates: ReadonlyArray<Decision>, now: number): Created => {
    const { ask, batch } = repo.addToCollecting(fresh, now);
    const publishedNow = isUrgent(ask) && repo.publishBatch(batch.n, now);
    return { tag: "new", ask, candidates, batch: repo.getBatch(batch.n)!, publishedNow };
  };

  /** After the commit: the ask's event, then the batch published now or on its quiet window. */
  const announce = (created: Extract<Created, { tag: "new" }>, now: number, summary: string, extra: Record<string, unknown> = {}) =>
    Effect.gen(function* () {
      const { ask } = created;
      yield* events.append({
        at: isoAt(now),
        type: "ask.created",
        ...projectFields(ask.projectRef),
        summary: summary.slice(0, 200),
        data: { askId: ask.askId, key: ask.key, class: ask.class, kind: ask.kind, batchId: ask.batchId, number: ask.number, ...extra },
      });
      if (created.publishedNow) {
        yield* FiberHandle.clear(timer);
        yield* events.append(batchReadyEvent(created.batch, now));
      } else {
        yield* schedule(created.batch.n, QUIET_WINDOW_MS);
      }
    });

  const create = (input: AskInput, by: string) =>
    Effect.gen(function* () {
      const refused = validateAsk(input);
      if (refused) return yield* refused;
      const now = yield* Clock.currentTimeMillis;
      const projectRef = input.projectRef;
      const chain = projectRef && { projectRef, ...(input.workstreamId ? { workstreamId: input.workstreamId } : {}) };
      const created = yield* write(repo, (): Created => {
        const base = (askId: AskId, state: AskState): Ask => ({
          askId,
          ...(projectRef ? { projectRef } : {}),
          ...(input.workstreamId ? { workstreamId: input.workstreamId } : {}),
          kind: input.kind,
          key: input.key,
          class: input.class as AskClass,
          text: input.text,
          ...(input.options ? { options: input.options } : {}),
          ...(input.recommendation === undefined ? {} : { recommendation: input.recommendation }),
          ...(input.steps ? { steps: input.steps } : {}),
          ...(input.verify === undefined ? {} : { verify: input.verify }),
          ...(input.sink === undefined ? {} : { sink: input.sink }),
          ...(input.envName === undefined ? {} : { envName: input.envName }),
          ...(input.gated === undefined ? {} : { gated: input.gated }),
          blocks: input.blocks,
          proceededOnRec: input.proceededOnRec,
          state,
          createdAt: isoAt(now),
        });
        // Each approve ask is its own question: a stored command is never answered from the log or merged with another.
        if (input.kind === "approve") {
          const fresh = repo.insertAsk(input.projectRef, input.key, input.workstreamId, by, now, (askId) => ({
            ...base(askId, "open"),
            key: DecisionKey.make(`gated.${askId.toLowerCase()}`),
          }));
          return placed(fresh, [], now);
        }
        // An unrouted ask has no project to look decisions up in, so it is always asked.
        const decision = chain && repo.resolve(input.key, chain);
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
        return placed(fresh, chain ? repo.searchDecisions(`${input.key} ${input.text}`, { chain, limit: 5 }) : [], now);
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
          yield* announce(created, now, `${ask.askId} [${ask.class}] ${ask.key}: ${ask.text}`);
          return { state: "open", ask, candidates: created.candidates } satisfies AskOutcome;
        }
      }
    });

  const withdraw = (askId: AskId, options: { readonly use?: DecisionId; readonly projectRef?: ProjectRef } = {}) =>
    write(repo, () => {
      const row = repo.getAskRow(askId);
      if (!row || (options.projectRef && projectKey(options.projectRef) !== askProjectKey(row.ask.projectRef))) {
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

  const update: Asks["Service"]["update"] = (askId, change) =>
    write(repo, () => {
      const row = repo.getAskRow(askId);
      if (!row) throw notFound(`No ask ${askId}.`);
      const next = change(row.ask);
      repo.putAsk(next);
      if (next.batchId) repo.closeIfDone(batchN(next.batchId)!);
      return next;
    });

  const reopen: Asks["Service"]["reopen"] = (askId, evidence) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const created = yield* write(repo, () => {
        const row = repo.getAskRow(askId);
        if (!row) throw notFound(`No ask ${askId}.`);
        if (row.ask.state !== "answered") throw invalid(`${askId} is ${row.ask.state}, not answered.`);
        const { answer: _, decisionId, ...rest } = row.ask;
        // Its answer no longer holds: a later ask with the same key must reach the human again.
        if (decisionId !== undefined && repo.getDecision(decisionId)?.state === "active") repo.retireDecision(decisionId);
        return placed({ ...rest, state: "open", evidence: evidence.slice(0, 2000) }, [], now);
      });
      if (created.tag !== "new") return created.ask;
      yield* announce(created, now, `${askId} reopened: ${evidence.split("\n")[0]}`, { reopened: true });
      return created.ask;
    });

  return Asks.of({
    create,
    update,
    reopen,
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
