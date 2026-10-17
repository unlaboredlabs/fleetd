import * as Layer from "effect/Layer";
import * as Asks from "../ledger/Asks.ts";
import * as Decisions from "../ledger/Decisions.ts";
import * as Inbox from "../ledger/Inbox.ts";
import * as LedgerRepo from "../ledger/LedgerRepo.ts";
import * as LeadRecords from "./LeadRecords.ts";
import * as Leads from "./Leads.ts";
import * as LeadWakes from "./LeadWakes.ts";
import * as Workstreams from "./Workstreams.ts";

/** Leads, Workstreams, LeadWakes and the ledger's AnswerSink. Needs HubDb, HubStore, EventLog, Executors, Asks and Decisions. */
export const layer = (options: Leads.LeadsOptions = {}) =>
  Layer.mergeAll(Leads.layer(options), Workstreams.layer, LeadWakes.layerAnswerSink).pipe(
    Layer.provideMerge(LeadWakes.layer()),
    Layer.provideMerge(LeadRecords.layer),
  );

/**
 * The leads layer together with the ledger. Inbox needs the AnswerSink that leads provide, and leads need Asks
 * and Decisions, so the ledger is built in two halves over one repo instead of with `Ledger.layer`.
 * Needs HubDb, HubStore, EventLog and Executors.
 */
export const layerWithLedger = (options: Leads.LeadsOptions = {}) =>
  Inbox.layer.pipe(
    Layer.provideMerge(layer(options)),
    Layer.provideMerge(Layer.mergeAll(Asks.layer, Decisions.layer)),
    Layer.provideMerge(LedgerRepo.layer),
  );
