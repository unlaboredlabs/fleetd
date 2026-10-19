// A steer between the composer and the hub's answer (steering-spec §2; GPUI's steers_reconnected, state.rs). Its
// client request id is minted once per composed steer and reused for every resend, so the hub (which dedupes on
// it) never stores the same steer twice. A call cut off by the link may have reached the hub: that is not "not
// sent". Only the hub's refusal, or no hub at all, is.

import type { Steer, SteerMode, SteerTarget } from "../../../shared/contracts";

export type SendState =
  | { readonly t: "sending" }
  /** The link dropped with the steer in flight: resent with the same id when it is back. */
  | { readonly t: "reconnecting" }
  /** The call timed out (twice): the hub may have it. Resent on the next reconnect, or by hand. */
  | { readonly t: "unanswered" }
  /** The hub never stored it: it refused it, or (a resend) there was no hub to ask. */
  | { readonly t: "failed"; readonly message: string; readonly offline?: boolean };

export interface Sending {
  /** The clientRequestId: the same on every resend. */
  readonly requestId: string;
  readonly target: SteerTarget;
  readonly workstreamId: string;
  readonly text: string;
  readonly mode: SteerMode;
  readonly at: string;
  readonly state: SendState;
  /** An earlier call was cut off: the hub may hold it, so it is never called "not sent". */
  readonly reached?: boolean;
}

export const taskOfTarget = (t: SteerTarget): string | undefined => ("taskId" in t ? t.taskId : undefined);


export type CallResult = { readonly ok: true; readonly steer: Steer } | { readonly ok: false; readonly code: string; readonly message: string };

/** One order's steers on their way to the hub, kept for the window's life (outbox.ts). */
export interface OrderSends {
  readonly sending: readonly Sending[];
  /** Steers redirected from this app ("Interrupt and redirect" isn't offered twice). */
  readonly redirected: ReadonlySet<string>;
}

export const noSends: OrderSends = { sending: [], redirected: new Set() };

export type SendAction =
  | { readonly t: "sending"; readonly s: Sending }
  | { readonly t: "sent"; readonly requestId: string; readonly result: CallResult }
  | { readonly t: "drop"; readonly requestId: string };

/**
 * What a steer_send answer does to its row: the hub's steer removes it, a cut-off keeps it for a resend. `offline`
 * (main never sent the call) means not sent, unless an earlier try may have reached the hub.
 */
export function afterCall(row: Sending, r: CallResult): Sending | undefined {
  if (r.ok) return undefined;
  if (r.code === "disconnected" || (r.code === "offline" && row.reached === true)) return { ...row, state: { t: "reconnecting" }, reached: true };
  if (r.code === "timeout") return { ...row, state: { t: "unanswered" }, reached: true };
  return { ...row, state: { t: "failed", message: r.message, ...(r.code === "offline" ? { offline: true } : {}) } };
}

export function sendsReducer(o: OrderSends, a: SendAction): OrderSends {
  switch (a.t) {
    case "sending": {
      // Upsert: a resend (same id) is the same row, in its place, and remembers an earlier cut-off.
      const at = o.sending.findIndex((x) => x.requestId === a.s.requestId);
      const old = o.sending[at];
      const row = old?.reached === true ? { ...a.s, reached: true } : a.s;
      return { ...o, sending: at === -1 ? [...o.sending, row] : o.sending.map((x, i) => (i === at ? row : x)) };
    }
    case "sent": {
      const row = o.sending.find((x) => x.requestId === a.requestId);
      if (row === undefined) return o;
      const next = afterCall(row, a.result);
      const sending = next ? o.sending.map((x) => (x.requestId === a.requestId ? next : x)) : o.sending.filter((x) => x.requestId !== a.requestId);
      const redirected = a.result.ok && a.requestId.startsWith("redirect:") ? new Set([...o.redirected, a.requestId.slice("redirect:".length)]) : o.redirected;
      return { sending, redirected };
    }
    case "drop":
      return { ...o, sending: o.sending.filter((x) => x.requestId !== a.requestId) };
  }
}

/** Rows to send again, with their own ids, once the link is back after it was really lost. */
export const toResend = (rows: readonly Sending[]): readonly Sending[] => rows.filter((r) => r.state.t === "reconnecting" || r.state.t === "unanswered");

/**
 * Watches the hub frames: after the link was really lost (a state frame other than live), the next snapshot hands
 * back the cut-off rows to resend. A snapshot while the link stayed up resends nothing.
 */
export function reconnectWatcher(): (frame: { readonly t: string; readonly state?: { readonly phase: string } }, rows: readonly Sending[]) => readonly Sending[] {
  let lost = false;
  return (frame, rows) => {
    if (frame.t === "state") {
      if (frame.state?.phase !== "live") lost = true;
      return [];
    }
    if (frame.t !== "snapshot" || !lost) return [];
    lost = false;
    return toResend(rows);
  };
}

/** "Interrupt and redirect" on a steer that wasn't acknowledged: one id per steer, so a second click is the same request. */
export const redirectId = (steerId: string): string => `redirect:${steerId}`;

/** Steers whose redirect is in flight or done: their receipt no longer offers it. */
export function redirecting(sending: readonly Sending[], done: ReadonlySet<string>): ReadonlySet<string> {
  const out = new Set(done);
  for (const s of sending) if (s.requestId.startsWith("redirect:") && s.state.t !== "failed") out.add(s.requestId.slice("redirect:".length));
  return out;
}

// Clocks differ a little between the app and the hub; a steer queued well before the send is an older one.
const SKEW_MS = 5000;

const sameSteer = (st: Steer, s: Sending): boolean =>
  st.text === s.text && taskOfTarget(st.target) === taskOfTarget(s.target) && Date.parse(st.queuedAt) >= Date.parse(s.at) - SKEW_MS;

/** The rows to show: a steer the hub turns out to have (steers_list after a reconnect) shows once, as the hub's. */
export const unsettled = (sending: readonly Sending[], steers: readonly Steer[]): readonly Sending[] =>
  sending.filter((s) => s.state.t === "failed" || !steers.some((st) => sameSteer(st, s)));
