import * as Layer from "effect/Layer";
import * as ClaimRecords from "../checks/ClaimRecords.ts";
import * as Estimates from "../estimates/Estimates.ts";
import * as Incidents from "../incidents/Incidents.ts";
import * as Asks from "../ledger/Asks.ts";
import * as Decisions from "../ledger/Decisions.ts";
import * as Inbox from "../ledger/Inbox.ts";
import * as LedgerRepo from "../ledger/LedgerRepo.ts";
import * as Playbooks from "../playbooks/Playbooks.ts";
import * as Research from "../playbooks/Research.ts";
import * as TaskRecords from "../tasks/TaskRecords.ts";
import * as ChangeRecords from "../train/ChangeRecords.ts";
import * as Usage from "../usage/Usage.ts";
import * as LeadRecords from "./LeadRecords.ts";
import * as Leads from "./Leads.ts";
import * as LeadWakes from "./LeadWakes.ts";
import * as Workstreams from "./Workstreams.ts";

/**
 * Leads, Workstreams, LeadWakes, TaskRecords, Usage and the ledger's AnswerSink, with the claim records, estimates,
 * incidents and merge-train Changes the lead digest shows, and the playbooks workstreams pin with their research
 * verdicts. Needs HubDb, HubStore, EventLog, Executors, WriteQueue, Asks and Decisions.
 */
export const layer = (options: Leads.LeadsOptions = {}) =>
  Layer.mergeAll(Leads.layer(options), Workstreams.layer, LeadWakes.layerAnswerSink, Research.layer).pipe(
    Layer.provideMerge(LeadWakes.layer()),
    // M4 usage: parks and paces lead and task threads; LeadWakes, Leads and Tasks consult it.
    Layer.provideMerge(Usage.layer),
    Layer.provideMerge(Layer.merge(Estimates.layer, ClaimRecords.layer)),
    Layer.provideMerge(Layer.mergeAll(LeadRecords.layer, TaskRecords.layer, Incidents.layer, ChangeRecords.layer)),
    Layer.provideMerge(Playbooks.layer(options.playbookOverrides === undefined ? {} : { overridesDir: options.playbookOverrides })),
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
