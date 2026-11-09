// The seam between areas that wake a project's lead and the leads area that does it (D348): the Rust hub's
// `hub.leads.wakes.trigger(r, Trigger)`. Until the leads area starts and
// replaces `trigger`, a wake goes nowhere.
import type { ProjectRef, WorkstreamId } from "../../shared/contracts.ts";
import type { Hub } from "./hub.ts";

/** What raised a line, as `LineKind` names it. */
export type LineKind =
  | "task_result"
  | "task_waiting"
  | "train"
  /** A person's words for the lead about an order (a steer, a stop). */
  | "human"
  /** A person raised the project's max agents (`tasks::cap`). */
  | "cap_raised"
  /** A secret or approval request settled, or came back open (`approvals`). */
  | "request"
  /** fleetd resumed a dead task, or one waits for its offline machine: never wakes the lead alone. */
  | "recovery"
  /** Agents on a machine kept dying, so fleetd stopped resuming them there (`tasks::breaker`). */
  | "recovery_paused"
  /** A finished task's PR, found after its result line went out (D67): rides along with the next wake too. */
  | "quiet"
  /** The lead's own turn was cut off by its node stopping or restarting. */
  | "cut_off"
  /** Work a Navi asked another project for opened, closed, merged or failed (hub/navi/bridge.rs). */
  | "factory";

/** Why a lead wakes: a person's order, or a line the area that raises it renders itself. */
export type Trigger =
  | { kind: "intent"; workstreamId: WorkstreamId; text: string }
  | { kind: "line"; line: LineKind; text: string };

export type LeadWakes = {
  /** Wakes the project's lead with `trigger` (a quiet one rides along with the next wake). */
  trigger(r: ProjectRef, trigger: Trigger): void;
};

/** The hub's lead wakes: `leadWakes(hub).trigger(r, …)`. The leads area replaces `trigger` when it starts. */
export const leadWakes = (hub: Hub): LeadWakes => hub.area<LeadWakes>("lead_wakes", () => ({ trigger: () => {} }));

/** `Trigger.quiet()`: never wakes the lead alone. */
export const quiet = (t: Trigger) => t.kind === "line" && (t.line === "recovery" || t.line === "quiet");

/** `Trigger::train(line)`. */
export const trainLine = (text: string): Trigger => ({ kind: "line", line: "train", text });
