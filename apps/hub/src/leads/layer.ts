import * as Layer from "effect/Layer";
import * as LeadRecords from "./LeadRecords.ts";
import * as Leads from "./Leads.ts";
import * as LeadWakes from "./LeadWakes.ts";
import * as Workstreams from "./Workstreams.ts";

/** Leads, Workstreams and LeadWakes. Needs HubDb, HubStore, EventLog, Executors and the LedgerPort. */
export const layer = (options: Leads.LeadsOptions = {}) =>
  Layer.mergeAll(Leads.layer(options), Workstreams.layer).pipe(
    Layer.provideMerge(LeadWakes.layer()),
    Layer.provideMerge(LeadRecords.layer),
  );
