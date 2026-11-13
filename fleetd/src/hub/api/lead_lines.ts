// What wakes a project's lead, as the areas that raise a line name it (leads.ts is the seam that delivers it).
import type { ProjectRef, WorkstreamId } from "../../shared/contracts.ts";

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
  /** A person moved a chat message to another order (`chat_about_set`): rides along with the next wake. */
  | "retag"
  /** The lead's own turn was cut off by its node stopping or restarting. */
  | "cut_off"
  /** Work a project asked another project for opened, closed, merged or failed (hub/project_lead/bridge.rs). */
  | "factory";

/** Why a lead wakes: a person's order, or a line the area that raises it renders itself. */
export type Trigger =
  | { kind: "intent"; workstreamId: WorkstreamId; text: string }
  | { kind: "line"; line: LineKind; text: string };

export type LeadWakes = {
  /** Wakes the project's lead with `trigger` (a quiet one rides along with the next wake). */
  trigger(r: ProjectRef, trigger: Trigger): void;
};

/** `Trigger.quiet()`: never wakes the lead alone. */
export const quiet = (t: Trigger) => t.kind === "line" && (t.line === "recovery" || t.line === "quiet" || t.line === "retag");

/** `Trigger::train(line)`. */
export const trainLine = (text: string): Trigger => ({ kind: "line", line: "train", text });
