// A cloud bot waking (W792, the person's pick from the waiting-state report): between a message to a bot whose computer
// is asleep and its lead's first words, the bot itself stands in the reply's place and wakes while its computer starts.
// Asleep before you write (ProjectChatState.leadAsleep), it stirs and keeps heavy lids while its computer starts, opens
// its eyes for its files, takes its thinking look, and its working look stands in for the typing dots until the reply
// lands where it sat. One quiet word beside it while it wakes, none once it thinks; past SLOW_MS the time so far, never
// an estimate; a failed try slumps, with one plain reason and a Try again that counts down to the start's own retry.
// Pure, so both apps draw the same states (app/mobile through its src/desktop.ts).
import type { BotState } from "./bot";
import type { Activity, StartStep } from "./contracts";

export type Wake =
  /** Its computer sleeps, and nothing runs: the next message starts it. */
  | { readonly phase: "asleep" }
  /** Its computer starts: the step, and when the start began (hub epoch ms; absent from a hub that doesn't say). */
  | { readonly phase: "waking"; readonly step: StartStep | undefined; readonly since: number | undefined }
  /** A try failed: why, and when it is tried again by itself (none: it waits on something else, as billing). */
  | { readonly phase: "failed"; readonly reason: string; readonly retryAt: number | undefined }
  /** Started, its lead thinks, or works before it writes. */
  | { readonly phase: "thinking" }
  | { readonly phase: "working" }
  /** Its first words stream: the bot stands in for the typing dots until the reply is whole. */
  | { readonly phase: "writing" };

export interface WakeIn {
  /** The chat state's leadAsleep. */
  readonly asleep: boolean;
  /** The chat state's leadWorking. */
  readonly working: boolean;
  /** The lead's live lane's activity now. */
  readonly activity: Activity | undefined;
  /** This turn began with a start (ColdTurns). */
  readonly cold: boolean;
  /** The lead's reply streams now. */
  readonly writing: boolean;
}

/** Past this, a start is slow: its word says so, with the time so far. */
export const SLOW_MS = 30_000;
/** How long the bot shows still asleep in the reply's place before it stirs, so the wake is seen and not skipped. */
export const STIR_MS = 900;

const ms = (at: string | undefined): number | undefined => {
  const t = at === undefined ? NaN : Date.parse(at);
  return Number.isNaN(t) ? undefined : t;
};

/** The wait now, or undefined: a turn that didn't begin with a start, or a lead that is neither asleep nor at work. */
export const wakeOf = (i: WakeIn): Wake | undefined => {
  const a = i.activity;
  if (i.working && a?.kind === "starting") {
    if (a.failed !== undefined) return { phase: "failed", reason: a.failed.reason, retryAt: ms(a.failed.retryAt) };
    return { phase: "waking", step: a.step, since: ms(a.startedAt) };
  }
  if (!i.working) return i.asleep ? { phase: "asleep" } : undefined;
  if (!i.cold) return undefined;
  if (i.writing || a?.kind === "writing") return { phase: "writing" };
  return a === undefined || a.kind === "thinking" || a.kind === "planning" ? { phase: "thinking" } : { phase: "working" };
};

/** The wait shows in the reply's place: from the start until the lead's first words, which it then stands in for. */
export const wakeShown = (w: Wake | undefined): boolean => w !== undefined && w.phase !== "asleep";

/** The bot's pose in the reply's place: still asleep until it stirs, heavy-lidded while its computer starts, eyes open
 * for its files, then the lead's own looks. */
export const wakePose = (w: Wake, stirred: boolean): BotState => {
  if (w.phase === "asleep" || (!stirred && w.phase === "waking")) return "asleep";
  switch (w.phase) {
    case "waking":
      return w.step === "files" || w.step === "session" || w.step === "message" ? "idle" : "waking";
    case "failed":
      return "error";
    case "thinking":
      return "thinking";
    case "working":
    case "writing":
      return "working";
  }
};

/** The word beside the bot (`nowMs` on the hub's clock): the step while its computer starts, "Still waking up" past
 * SLOW_MS (with `count`, the time so far), the reason after a failed try; nothing once it thinks. */
export const wakeWords = (w: Wake, nowMs: number): { readonly words: string; readonly count?: string } | undefined => {
  switch (w.phase) {
    case "waking": {
      if (w.since !== undefined && nowMs - w.since >= SLOW_MS) return { words: "Still waking up", count: waited(nowMs - w.since) };
      return { words: w.step === "files" ? "Getting its files" : w.step === "session" || w.step === "message" ? "Getting ready" : "Waking up" };
    }
    case "failed": {
      const reason = w.reason.trim().replace(/[.\s]+$/u, "");
      return { words: reason === "" ? "Couldn’t wake up." : `Couldn’t wake up. ${reason.charAt(0).toUpperCase()}${reason.slice(1)}.` };
    }
    default:
      return undefined;
  }
};

/** Try again's label: with the seconds until the start tries again by itself, while it waits for that. */
export const tryAgainLabel = (w: Extract<Wake, { phase: "failed" }>, nowMs: number): string => {
  const left = w.retryAt === undefined ? 0 : Math.ceil((w.retryAt - nowMs) / 1000);
  return left > 0 ? `Try again · ${String(left)}s` : "Try again";
};

/** "34s", "1m 05s": how long it has waited. */
export const waited = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${String(s)}s` : `${String(Math.floor(s / 60))}m ${String(s % 60).padStart(2, "0")}s`;
};

/**
 * Which bots' current turns began with a start: a turn is cold from the first `starting` activity seen while its lead
 * works until it stops working. One per app; `see` is told each bot's state as it changes and answers whether its turn
 * is cold.
 */
export class ColdTurns {
  private readonly cold = new Set<string>();
  see(key: string, working: boolean, activity: Activity | undefined): boolean {
    if (!working) this.cold.delete(key);
    else if (activity?.kind === "starting") this.cold.add(key);
    return this.cold.has(key);
  }
}
