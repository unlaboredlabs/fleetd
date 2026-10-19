// A steer between the composer and the hub's answer (steering-spec §2; GPUI's steers_reconnected, state.rs). Its
// client request id is minted once per composed steer and reused for every resend, so the hub (which dedupes on
// it) never stores the same steer twice. A call cut off by the link may have reached the hub: that is not "not
// sent". Only the hub's refusal, or no hub at all, is.

import type { Steer, SteerMode, SteerTarget } from "../../../shared/contracts";

export type SendState =
  | { readonly t: "sending" }
  /** The link dropped or the call timed out with the steer in flight: resent with the same id when it is back. */
  | { readonly t: "reconnecting" }
  | { readonly t: "failed"; readonly message: string };

export interface Sending {
  /** The clientRequestId: the same on every resend. */
  readonly requestId: string;
  readonly target: SteerTarget;
  readonly workstreamId: string;
  readonly text: string;
  readonly mode: SteerMode;
  readonly at: string;
  readonly state: SendState;
}

export const taskOfTarget = (t: SteerTarget): string | undefined => ("taskId" in t ? t.taskId : undefined);

/** The ids the hub can't have answered: the link went away under the call. */
const CUT_OFF = new Set(["disconnected", "timeout"]);

export type CallResult = { readonly ok: true; readonly steer: Steer } | { readonly ok: false; readonly code: string; readonly message: string };

/** What a steer_send answer does to its row: the hub's steer replaces it, a cut-off keeps it for a resend. */
export function afterCall(row: Sending, r: CallResult): { readonly row?: Sending; readonly steer?: Steer } {
  if (r.ok) return { steer: r.steer };
  if (CUT_OFF.has(r.code)) return { row: { ...row, state: { t: "reconnecting" } } };
  return { row: { ...row, state: { t: "failed", message: r.message } } };
}

/** Rows to send again, with their own ids, once the link is back after it was really lost. */
export const toResend = (rows: readonly Sending[]): readonly Sending[] => rows.filter((r) => r.state.t === "reconnecting");

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
