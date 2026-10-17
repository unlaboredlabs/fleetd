import * as Layer from "effect/Layer";
import * as Incidents from "../incidents/Incidents.ts";
import * as Asks from "./Asks.ts";
import * as Decisions from "./Decisions.ts";
import * as Inbox from "./Inbox.ts";
import * as LedgerRepo from "./LedgerRepo.ts";

/** Decisions, Asks and Inbox over one repo, with the incidents the inbox records. Needs HubDb, EventLog and an AnswerSink. */
export const layer = Layer.mergeAll(Decisions.layer, Asks.layer, Inbox.layer).pipe(
  Layer.provide(LedgerRepo.layer),
  Layer.provideMerge(Incidents.layer),
);
