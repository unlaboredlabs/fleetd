// A steer's receipt as one line under its message (steering-spec §2, §7): queued → delivered → acknowledged, or
// honestly not. The stages are decided by the hub from claude's own frames; this only words them.

import type { AgentLane, Steer, SteerStage } from "../../../shared/contracts";
import type { Sending } from "./sending";
import { clip, clock, inlinePlain, shortElapsed } from "./format";

export type Tone = "quiet" | "good" | "warn" | "bad";

/** What the receipt offers: drop a queued steer, or resend an ignored one as ⌘Enter. */
export type ReceiptAct = { readonly kind: "withdraw"; readonly steerId: string } | { readonly kind: "redirect"; readonly steerId: string };

export interface Receipt {
  readonly stage: SteerStage | "sending" | "not_sent";
  readonly line: string;
  readonly tone: Tone;
  readonly act?: ReceiptAct;
  /** The hub's own words on a failure, behind Details rather than in the line. */
  readonly detail?: string;
}

// A refetch can answer with an older stage than an event already told us; a receipt never moves back. A late
// `--steer` ack turns "not acknowledged" into "acknowledged", never the other way.
const RANK: Readonly<Record<SteerStage, number>> = { queued: 0, delivered: 1, unacknowledged: 2, acknowledged: 3, withdrawn: 3, failed: 3, expired: 3 };
const rank = (stage: SteerStage): number => RANK[stage];

const steerNumber = (id: string): number => Number(id.slice(1)) || Number.MAX_SAFE_INTEGER;

/** Folds `incoming` into `rows`, kept in steer-number order. Returns a new array only when something changed. */
export function mergeSteer(rows: readonly Steer[], incoming: Steer): readonly Steer[] {
  const at = rows.findIndex((s) => s.id === incoming.id);
  if (at === -1) return [...rows, incoming].sort((a, b) => steerNumber(a.id) - steerNumber(b.id));
  const row = rows[at];
  if (row === undefined || rank(incoming.stage) < rank(row.stage)) return rows;
  const next = rows.slice();
  next[at] = incoming;
  return next;
}

/** Only a queued steer, and only one a person sent: once delivered it can't be unsaid. */
export const canWithdraw = (s: Steer): boolean => s.stage === "queued" && s.by.kind === "human";

/** `redirected`: its "Interrupt and redirect" is already in flight or done, so it isn't offered again. */
export function receipt(s: Steer, redirected = false): Receipt {
  const at = (t: string | undefined) => (t ? ` ${clock(t)}` : "");
  const detail = s.detail ? ` · ${s.detail}` : "";
  const base = { stage: s.stage };
  switch (s.stage) {
    case "queued":
      return { ...base, line: `${s.id} · queued ${clock(s.queuedAt)}${detail}`, tone: "quiet", ...withdraw(s) };
    case "delivered": {
      const how =
        s.how === "turn"
          ? " · started a turn"
          : s.how === "boundary"
            ? " · after its running step"
            : s.how === "stopped"
              ? s.stoppedTool
                ? ` · stopped \`${clip(s.stoppedTool, 60)}\``
                : " · stopped its current step"
              : s.how === "joined"
                ? " · joined its running turn"
                : "";
      return { ...base, line: `${s.id} · delivered${at(s.deliveredAt)}${how}${detail}`, tone: "quiet" };
    }
    case "acknowledged": {
      const said = s.ackExcerpt ? ` · “${clip(inlinePlain(s.ackExcerpt), 90)}”` : "";
      const plan = s.planChange ? ` · ${s.planChange}` : "";
      return { ...base, line: `${s.id} · acknowledged${at(s.ackedAt)}${said}${plan}`, tone: "good" };
    }
    case "unacknowledged": {
      const reply = s.ackExcerpt ? ` · its reply: “${clip(inlinePlain(s.ackExcerpt), 80)}”` : "";
      return { ...base, line: `${s.id} · not acknowledged${reply}`, tone: "warn", ...(redirected ? {} : { act: { kind: "redirect", steerId: s.id } }) };
    }
    case "withdrawn":
      return { ...base, line: `${s.id} · withdrawn`, tone: "quiet" };
    case "failed":
      return { ...base, line: `${s.id} · failed${s.detail ? `: ${s.detail}` : ""}`, tone: "bad" };
    case "expired":
      return { ...base, line: `${s.id} · expired before it was delivered${detail}`, tone: "bad" };
  }
}

const withdraw = (s: Steer): { act?: ReceiptAct } => (canWithdraw(s) ? { act: { kind: "withdraw", steerId: s.id } } : {});

export function sendingReceipt(s: Sending): Receipt {
  switch (s.state.t) {
    case "sending":
      return { stage: "sending", line: "sending…", tone: "quiet" };
    case "reconnecting":
      return { stage: "sending", line: "sending… (reconnecting; it is sent again when the hub is back)", tone: "quiet" };
    case "failed":
      return { stage: "not_sent", line: "not sent: the hub refused it. Your words are still in the box.", tone: "bad", detail: s.state.message };
  }
}

/**
 * "S12 waits for the lead's next step (running cargo test for 1m12s)": the oldest queued steer while the agent is
 * mid-step. Undefined when nothing waits, or the agent is idle (a steer to an idle agent starts its turn at once).
 */
export function waitingLine(steers: readonly Steer[], lane: AgentLane | undefined, possessive: string, nowMs: number): string | undefined {
  const s = steers.find((x) => x.stage === "queued");
  if (s === undefined || lane === undefined || (lane.status !== "working" && lane.status !== "starting")) return undefined;
  const now = lane.live?.activity;
  const since = now ? Date.parse(now.since) : Number.NaN;
  const took = Number.isNaN(since) ? undefined : shortElapsed(nowMs - since);
  let doing = "";
  if (now && took !== undefined) {
    const a = now.activity;
    doing =
      a.kind === "command"
        ? ` (running \`${clip(a.text, 48)}\` for ${took})`
        : a.kind === "edit"
          ? ` (editing \`${clip(a.path, 48)}\`, ${took})`
          : a.kind === "tool"
            ? ` (${a.name}, ${took})`
            : ` (${a.kind}, ${took})`;
  }
  return `${s.id} waits for ${possessive} next step${doing}`;
}
