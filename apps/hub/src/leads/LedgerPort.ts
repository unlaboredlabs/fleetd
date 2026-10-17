// What the leads area needs from the ledger (asks, batches, decisions; apps/hub/src/ledger, M3a). The ledger was
// built in parallel, so this is a minimal port; main.ts (M3d) provides it from the real ledger service.
import type { Ask, AskId, Decision, DecisionId, DecisionScope, ProjectRef } from "@fleetd/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { AnswerNote } from "./digest.ts";

export class LedgerPort extends Context.Service<
  LedgerPort,
  {
    readonly getAsk: (askId: AskId) => Effect.Effect<Ask | undefined>;
    readonly getDecision: (decisionId: DecisionId) => Effect.Effect<Decision | undefined>;
    /** The project's asks in state "open". */
    readonly openAsks: (ref: ProjectRef) => Effect.Effect<ReadonlyArray<Ask>>;
    /** Active decisions in any of `scopes`. */
    readonly activeDecisions: (scopes: ReadonlyArray<DecisionScope>) => Effect.Effect<ReadonlyArray<Decision>>;
    /**
     * Registers `handler` for every ask a human reply settles: answered (with its Decision) or dropped with
     * "nvm" (no decision). Called after the ledger has committed the change.
     */
    readonly onAnswered: (handler: (note: AnswerNote) => Effect.Effect<void>) => Effect.Effect<void>;
  }
>()("fleetd/leads/LedgerPort") {}
