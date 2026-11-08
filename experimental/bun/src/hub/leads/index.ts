// The leads area's reads other areas use (crates/fleetd/src/hub/leads/lead.rs `Leads::get`, `lead_state`;
// records.rs `leads_list`, `lead_profile_get`). `leads(hub).get(r)` is a project's lead with its state read off its
// thread, as `hub.leads.leads.get` answers it.
import type { Lead, LeadState, ProjectRef, ThreadSummary, UsageParked } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { store } from "../store/hub_store.ts";
import { LeadRecords, type StoredLead } from "./records.ts";

/** The lead's state, read off its thread as the shell stream last reported it; stopped once the project was removed. */
export function leadState(thread: ThreadSummary | undefined, projectGone: boolean): LeadState {
  if (projectGone) return "stopped";
  if (!thread) return "starting";
  switch (thread.status) {
    case "running":
      return "working";
    case "waiting":
    case "failed":
      return "stalled";
    default:
      return "idle";
  }
}

/** What the usage area says of a parked lead thread; set by that area once it is ported. */
export type ParkedOf = (thread: { machineId: string; threadId: string }) => UsageParked | undefined;

export class Leads {
  readonly records: LeadRecords;
  /** The usage area's hook (Rust `LeadHooks::parked_of`): none until it sets one. */
  parkedOf: ParkedOf = () => undefined;

  constructor(private readonly hub: Hub) {
    this.records = new LeadRecords(hub.db);
  }

  /** The project's lead with its state, or undefined when it has none. */
  get(r: ProjectRef): Lead | undefined {
    const lead = this.records.leadGet(r);
    return lead ? this.withState(lead) : undefined;
  }

  /** Every project's lead, by machine and project. */
  list(): Lead[] {
    return this.records.leadsList().map((l) => this.withState(l));
  }

  withState(lead: StoredLead): Lead {
    const ref = { machineId: lead.projectRef.machineId, threadId: lead.threadId };
    const thread = store(this.hub).threadGet(ref)?.thread;
    const parked = this.parkedOf(ref);
    const gone = store(this.hub).projectGet(lead.projectRef) === undefined;
    return {
      state: leadState(thread, gone),
      projectRef: lead.projectRef,
      threadId: lead.threadId,
      startedAt: lead.startedAt,
      ...(lead.lastWakeAt === undefined ? {} : { lastWakeAt: lead.lastWakeAt }),
      sessionGeneration: lead.sessionGeneration,
      ...(parked === undefined ? {} : { parked }),
    };
  }
}

/** The hub's leads area: `leads(hub).get(r)`, `leads(hub).list()`. */
export const leads = (hub: Hub) => hub.area("leads", (h) => new Leads(h));

/** The profile the project's current lead session started on (records.rs `lead_profile_get`). */
export const leadProfile = (hub: Hub, r: ProjectRef) => leads(hub).records.leadProfileGet(r);
