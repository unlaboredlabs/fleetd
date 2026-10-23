// Steering one agent (or the lead) mid-run, pure: which key sends which way, where a lead steer goes, and what a
// steer's receipt says. The hub decides every stage from the agent's own frames (steer_send, steers_list, steer.*);
// these only word them. A steer speaks for the person, so it goes with the app's own key, as chat does.

import type { OrderCard, Steer, SteerMode } from "../../../shared/contracts";
import { sendsOn, type KeyLike } from "../chat/composerModel";

export type SteerKey = KeyLike & { readonly metaKey: boolean; readonly ctrlKey: boolean };

/** Enter: at the agent's next step. ⌘Enter (Ctrl+Enter off macOS): stop its current step and deliver now. */
export const steerModeOn = (e: SteerKey): SteerMode | undefined => {
  if (!sendsOn(e)) return undefined;
  return e.metaKey || e.ctrlKey ? "now" : "queue";
};

/** The lead composer: ⌘Enter while the lead works on an order steers it now; every other send is a chat message. */
export const composerSendOn = (e: SteerKey, leadSteerable: boolean): "now" | "chat" | undefined => {
  const mode = steerModeOn(e);
  if (mode === undefined) return undefined;
  return mode === "now" && leadSteerable ? "now" : "chat";
};

/**
 * The open order a lead steer names (steer_send's lead target is an order): the project's most recently active one.
 * None when the lead works on no order, and then the composer sends a plain message.
 */
export const leadOrder = (orders: Readonly<Record<string, OrderCard>> | undefined, project: { readonly machineId: string; readonly projectId: string }): string | undefined => {
  let best: OrderCard | undefined;
  for (const o of Object.values(orders ?? {})) {
    if (o.projectRef.machineId !== project.machineId || o.projectRef.projectId !== project.projectId) continue;
    if (best === undefined || o.updatedAt > best.updatedAt) best = o;
  }
  return best?.workstreamId;
};

/** steer_send's limit on a steer's text (IntakeText). */
export const STEER_MAX = 4000;

/** Why these words can't go as a steer, or undefined when they can. */
export const steerTooLong = (text: string): string | undefined =>
  text.length > STEER_MAX ? `A steer is at most ${STEER_MAX.toLocaleString("en-US")} characters; this is ${text.length.toLocaleString("en-US")}.` : undefined;

/** `S12` → 12, for newest first. */
const nOf = (id: string): number => Number(id.slice(1)) || 0;

/**
 * The receipts to show: what this window sent (its own answer until the list has it), then, unless `onlySent`, the
 * person's other steers to this target the hub lists. Newest first, at most `max`.
 */
export function receiptsToShow(listed: readonly Steer[] | undefined, sent: readonly Steer[], onlySent: boolean, max = 3): readonly Steer[] {
  const byId = new Map<string, Steer>();
  for (const s of sent) byId.set(s.id, s);
  for (const s of listed ?? []) {
    if (s.by.kind !== "human") continue;
    if (byId.has(s.id) || !onlySent) byId.set(s.id, s);
  }
  return [...byId.values()].toSorted((a, b) => nOf(b.id) - nOf(a.id)).slice(0, max);
}

export interface SteerReceipt {
  readonly tone: "quiet" | "warn" | "bad";
  readonly line: string;
  /** The agent's reply that acknowledged it, as it wrote it. */
  readonly quote?: string;
  /** Why it failed, in the hub's words, behind Details. */
  readonly detail?: string;
  /** Still queued: it can be taken back. */
  readonly withdraw: boolean;
}

/** One steer's receipt, state first. "It" is the agent (or the lead) it went to. */
export function steerReceipt(s: Steer): SteerReceipt {
  const quiet = (line: string, more: Partial<SteerReceipt> = {}): SteerReceipt => ({ tone: "quiet", line, withdraw: false, ...more });
  switch (s.stage) {
    case "queued": {
      // detail is the hub's own words on why it waits; it names ids, so it is read, never shown.
      const line = s.detail?.startsWith("queued until")
        ? "Queued: it gets this when it starts"
        : s.detail?.startsWith("waiting for")
          ? "Queued: its computer is offline; this goes when it’s back"
          : s.mode === "now"
            ? "Stopping its current step…"
            : "Queued: it reads this at its next step";
      return quiet(line, { withdraw: true });
    }
    case "delivered":
      switch (s.how) {
        case "stopped":
          return quiet("Delivered: it stopped its step to read this");
        case "boundary":
          return quiet("Delivered after its running step");
        case "turn":
          return quiet("Delivered: it started on this");
        default:
          return quiet("Delivered");
      }
    case "acknowledged":
      return quiet("Acknowledged", s.ackExcerpt === undefined ? {} : { quote: s.ackExcerpt });
    case "unacknowledged":
      return { tone: "warn", line: "Delivered, but it hasn’t replied to it", withdraw: false };
    case "withdrawn":
      return quiet("Withdrawn: it never saw this");
    case "expired":
      return { tone: "bad", line: "Not delivered: its computer stayed offline too long", withdraw: false };
    case "failed":
      return { tone: "bad", line: "Didn’t reach it", ...(s.detail === undefined ? {} : { detail: s.detail }), withdraw: false };
  }
}

/** Why a steer didn't go, in one plain sentence. */
export function steerFailed(code: string): string {
  switch (code) {
    case "forbidden":
      return "This computer’s key can’t steer this project’s agents.";
    case "offline":
    case "disconnected":
      return "Not connected to the hub, so it wasn’t sent.";
    case "timeout":
      return "The hub didn’t answer; it may have it. Check its receipt before sending again.";
    case "invalid":
    case "not_found":
      return "It isn’t running now, so it wasn’t sent.";
    default:
      return "Couldn’t send it. Try again.";
  }
}
