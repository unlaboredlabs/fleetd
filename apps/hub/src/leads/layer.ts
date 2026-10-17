import * as Layer from "effect/Layer";
import * as ClaimRecords from "../checks/ClaimRecords.ts";
import * as Estimates from "../estimates/Estimates.ts";
import * as Incidents from "../incidents/Incidents.ts";
import * as Asks from "../ledger/Asks.ts";
import * as Decisions from "../ledger/Decisions.ts";
import * as Inbox from "../ledger/Inbox.ts";
import * as LedgerRepo from "../ledger/LedgerRepo.ts";
import * as TaskRecords from "../tasks/TaskRecords.ts";
import * as LeadRecords from "./LeadRecords.ts";
import * as Leads from "./Leads.ts";
import * as LeadWakes from "./LeadWakes.ts";
import * as Workstreams from "./Workstreams.ts";

/**
 * Leads, Workstreams, LeadWakes, TaskRecords and the ledger's AnswerSink, with the claim records, estimates and
 * incidents the lead digest shows. Needs HubDb, HubStore, EventLog, Executors, WriteQueue, Asks and Decisions.
 */
export const layer = (options: Leads.LeadsOptions = {}) =>
  Layer.mergeAll(Leads.layer(options), Workstreams.layer, LeadWakes.layerAnswerSink).pipe(
    Layer.provideMerge(LeadWakes.layer()),
    Layer.provideMerge(Layer.merge(Estimates.layer, ClaimRecords.layer)),
    Layer.provideMerge(Layer.mergeAll(LeadRecords.layer, TaskRecords.layer, Incidents.layer)),
  );

/**
 * The leads layer together with the ledger. Inbox needs the AnswerSink that leads provide, and leads need Asks
 * and Decisions, so the ledger is built in two halves over one repo instead of with `Ledger.layer`. Includes the
 * wakes for decisions recorded outside the inbox.
 * Needs HubDb, HubStore, EventLog, Executors and WriteQueue.
 */
export const layerWithLedger = (options: Leads.LeadsOptions = {}) =>
  Layer.merge(Inbox.layer, LeadWakes.layerDecisionWakes).pipe(
    Layer.provideMerge(layer(options)),
    Layer.provideMerge(Layer.mergeAll(Asks.layer, Decisions.layer)),
    Layer.provideMerge(LedgerRepo.layer),
  );
