// The seam between areas that wake a project's lead and the leads area that does it (D348): the Rust hub's
// `hub.leads.wakes.trigger(r, Trigger)`. Until the leads area starts and
// replaces `trigger`, a wake goes nowhere.
import type { Hub } from "./hub.ts";
import type { LeadWakes, Trigger } from "./lead_lines.ts";

export { type LeadWakes, type LineKind, quiet, trainLine, type Trigger } from "./lead_lines.ts";

/** The hub's lead wakes: `leadWakes(hub).trigger(r, …)`. The leads area replaces `trigger` when it starts. */
export const leadWakes = (hub: Hub): LeadWakes => hub.area<LeadWakes>("lead_wakes", () => ({ trigger: () => {} }));
