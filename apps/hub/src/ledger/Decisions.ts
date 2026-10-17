import type { Decision, DecisionId, DecisionKey, HubEvent, ProjectRef } from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EventLog from "../store/EventLog.ts";
import {
  type Actor,
  type Chain,
  type DecisionFilter,
  type LedgerError,
  LedgerRepo,
  type RecordInput,
  write,
} from "./LedgerRepo.ts";

/** The keyed decision log, scoped workstream → project → global. */
export class Decisions extends Context.Service<
  Decisions,
  {
    /** Writes an active decision; an active one on the same key and scope becomes superseded. */
    readonly record: (input: RecordInput, actor: Actor) => Effect.Effect<Decision>;
    /** `forget Dn`: an active decision stops answering its key. */
    readonly retire: (decisionId: DecisionId) => Effect.Effect<Decision, LedgerError>;
    readonly get: (decisionId: DecisionId) => Effect.Effect<Decision | undefined>;
    /** The active decision for `key`, looked up in the workstream, then the project, then globally. */
    readonly resolve: (key: DecisionKey, chain: Chain) => Effect.Effect<Decision | undefined>;
    /** FTS5 over key, value and why; best match first, active only. */
    readonly search: (query: string, filter?: DecisionFilter) => Effect.Effect<ReadonlyArray<Decision>>;
    /** Active decisions, newest first. */
    readonly list: (filter: DecisionFilter) => Effect.Effect<ReadonlyArray<Decision>>;
  }
>()("fleetd/ledger/Decisions") {}

/** The `decision.recorded` event; `project` names the project of a workstream-scoped decision. */
export const recordedEvent = (decision: Decision, project?: ProjectRef): Omit<HubEvent, "seq"> => {
  const projectRef = decision.scope.kind === "project" ? decision.scope.projectRef : project;
  return {
    at: decision.at,
    type: "decision.recorded",
    ...(projectRef ? { machineId: projectRef.machineId, projectId: projectRef.projectId } : {}),
    summary: `${decision.decisionId} ${decision.key} = ${decision.value}`,
    data: {
      decisionId: decision.decisionId,
      key: decision.key,
      scope: decision.scope,
      source: decision.source,
      ...(decision.supersedes ? { supersedes: decision.supersedes } : {}),
      ...(decision.askId ? { askId: decision.askId } : {}),
    },
  };
};

const make = Effect.gen(function* () {
  const repo = yield* LedgerRepo;
  const events = yield* EventLog.EventLog;

  const record = (input: RecordInput, actor: Actor) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const decision = yield* write(repo, () => repo.recordDecision(input, actor, now)).pipe(Effect.orDie);
      yield* events.append(recordedEvent(decision, input.projectRef));
      return decision;
    });

  return Decisions.of({
    record,
    retire: (decisionId) => write(repo, () => repo.retireDecision(decisionId)),
    get: (decisionId) => Effect.sync(() => repo.getDecision(decisionId)),
    resolve: (key, chain) => Effect.sync(() => repo.resolve(key, chain)),
    search: (query, filter = {}) => Effect.sync(() => repo.searchDecisions(query, filter)),
    list: (filter) => Effect.sync(() => repo.listDecisions(filter)),
  });
});

export const layer = Layer.effect(Decisions, make);
