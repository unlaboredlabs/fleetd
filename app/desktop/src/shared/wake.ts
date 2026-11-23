// The bot in the reply's place (W792, W852): from the moment you send until the lead answers, the bot itself stands
// under your message, with typing dots while its lead takes it and works on it, as a person's avatar does in Messages.
// It goes when the reply lands, or when the lead is idle after a turn that ended since your message (a quiet turn; the
// hub's chat state says when, leadIdleAt), and comes back if the lead works on it again (the hub's follow-up). While
// the lead can't take your message it says why in one plain line instead (its machine offline, its usage paused, not
// sent yet); after START_SLOW_MS with no start and no reason, that it waits for the lead to start, with the time so far;
// past START_STALE_MS, that the lead didn't start and what to do, never a wait that goes on or goes without a word.
// A cloud bot whose computer is asleep wakes there: asleep before you write (ProjectChatState.leadAsleep), it stirs
// and keeps heavy lids while its computer starts, opens its eyes for its files, then takes the lead's looks. One quiet
// word beside it while it wakes; past SLOW_MS the time so far, never an estimate; a failed try slumps, with one plain
// reason and a Try again that counts down to the start's own retry.
// Pure, so both apps draw the same states (app/mobile through its src/desktop.ts).
import type { BotState } from "./bot";
import type { Activity, StartStep } from "./contracts";

export type Wake =
  /** Its computer sleeps, and nothing runs: the next message starts it. */
  | { readonly phase: "asleep" }
  /** Its computer starts: the step, and when the start began (hub epoch ms; absent from a hub that doesn't say). */
  | { readonly phase: "waking"; readonly step: StartStep | undefined; readonly since: number | undefined }
  /** A try failed: why, and when it is tried again by itself. */
  | { readonly phase: "failed"; readonly reason: string; readonly retryAt: number | undefined }
  /** Started, its lead thinks, or works before it writes. */
  | { readonly phase: "thinking" }
  /** At work; `retry`: Claude isn't serving its calls, and its claude has retried since then (hub epoch ms), why in
   * the tracker's words ("overloaded", a status, an error). */
  | { readonly phase: "working"; readonly retry?: { readonly reason: string; readonly since: number } }
  /** Its first words stream: the bot stays in the reply's place until the reply is whole. */
  | { readonly phase: "writing" }
  /** Your message is in and the lead hasn't started on it yet: since when you sent it (hub epoch ms; undefined: just now). */
  | { readonly phase: "received"; readonly since: number | undefined }
  /** The lead can't take your message now, or (`start`) its start waits on something no try fixes, the team's billing:
   * why, in plain words. */
  | { readonly phase: "held"; readonly reason: string; readonly start?: true }
  /** Past START_STALE_MS the lead, idle since before your message, never started on it. */
  | { readonly phase: "unstarted" };

export interface WakeIn {
  /** The chat state's leadAsleep. */
  readonly asleep: boolean;
  /** The chat state's leadWorking. */
  readonly working: boolean;
  /** The lead's live lane's activity now. */
  readonly activity: Activity | undefined;
  /** Since when it does that (hub epoch ms): a run of retries, from the first. */
  readonly activitySince?: number | undefined;
  /** This turn began with a start (ColdTurns). */
  readonly cold: boolean;
  /** The lead's reply streams now. */
  readonly writing: boolean;
  /** When the person's newest message came (hub epoch ms, `askedAt`): a wake counts from there at the earliest. */
  readonly asked?: number | undefined;
  /** The person's newest message has no answer yet (`waitingFor`): the bot stands in the reply's place while the lead
   * works, on any turn, the hub's follow-up after a quiet one included. */
  readonly waiting?: boolean | undefined;
  /**
   * When the lead was last seen to stop (hub epoch ms): the hub's leadIdleAt, or a stop this app saw. Idle since
   * `asked` or later, its turn had your message and ended (a quiet turn): the bot leaves the reply's place.
   */
  readonly endedAt?: number | undefined;
  /** The hub says when the lead's turns end (leadIdleAt): a start that never came is one it can name. */
  readonly idleKnown?: boolean | undefined;
  /** The hub's word that the lead doesn't have it (`heldWords` of chat_send's leadWaiting): said even while it works. */
  readonly held?: string | undefined;
  /** Why the bot can't start (`heldWords` of Status's blocked reason): said only while its lead isn't at work. */
  readonly blocked?: string | undefined;
  /** That message came longer than START_STALE_MS ago on the hub's clock: a lead that hasn't started on it never will. */
  readonly stale?: boolean | undefined;
}

/** Past this, a start is slow: its word says so, with the time so far. */
export const SLOW_MS = 30_000;
/** How long the bot shows still asleep in the reply's place before it stirs, so the wake is seen and not skipped. */
export const STIR_MS = 900;
/** Past this of Claude's retries, the bot says in a plain line that Claude isn't answering and the lead retries. */
export const RETRY_SAID_MS = 20_000;
/** Past this with no start and no reason, the bot says it waits for the lead to start, with the time so far. */
export const START_SLOW_MS = 10_000;
/** Past this, a lead idle since before your message never started on it: the bot says so, and what to do. */
export const START_STALE_MS = 10 * 60_000;

const ms = (at: string | undefined): number | undefined => {
  const t = at === undefined ? NaN : Date.parse(at);
  return Number.isNaN(t) ? undefined : t;
};

/** A held start's reason as the bot says it: "The lead can’t start now: this team reached its spend cap." */
const heldStart = (reason: string): string => {
  const r = reason.trim();
  // Lowered only where it is a sentence's first word ("This team…"), never a name or an acronym ("GitHub", "API").
  return heldWords({ blocked: /^[A-Z][a-z]*(?=[\s,.:;]|$)/u.test(r) ? `${r.charAt(0).toLowerCase()}${r.slice(1)}` : r }) ?? "The lead can’t start now.";
};

/** The wait now, or undefined: a lead that is neither asleep nor at work, with nothing of yours to answer. */
export const wakeOf = (i: WakeIn): Wake | undefined => {
  const a = i.activity;
  if (i.working && a?.kind === "starting") {
    // A start that waits on something no try fixes (no retry of its own: the team's billing) is held, not failed: it
    // goes on by itself once that is settled, so nothing offers Try again.
    if (a.failed !== undefined) return a.failed.retryAt === undefined ? { phase: "held", reason: heldStart(a.failed.reason), start: true } : { phase: "failed", reason: a.failed.reason, retryAt: ms(a.failed.retryAt) };
    // A start older than the person's message (one it joined, or a hub that kept an old start's time) counts from
    // the message: the wait they see is this one.
    const since = ms(a.startedAt);
    return { phase: "waking", step: a.step, since: since === undefined || i.asked === undefined ? since : Math.max(since, i.asked) };
  }
  // Idle after a turn that ended since your message (a quiet one): that turn had it.
  const ended = !i.working && i.endedAt !== undefined && i.asked !== undefined && i.endedAt >= i.asked;
  const waiting = i.waiting === true && !ended;
  // The hub said your message hasn't reached the lead: whatever it works on, it isn't this.
  if (waiting && i.held !== undefined) return { phase: "held", reason: i.held };
  if (i.working) {
    // A lead at work on its own (after its reply, or with nothing asked) has the island's line, not the bot.
    if (!i.cold && !waiting) return undefined;
    if (i.writing || a?.kind === "writing") return { phase: "writing" };
    if (a?.kind === "retrying") return { phase: "working", ...(i.activitySince === undefined ? {} : { retry: { reason: a.reason, since: i.activitySince } }) };
    return a === undefined || a.kind === "thinking" || a.kind === "planning" ? { phase: "thinking" } : { phase: "working" };
  }
  if (waiting) {
    if (i.blocked !== undefined) return { phase: "held", reason: i.blocked };
    // Its computer starts on your message: it stirs at once, before the hub's first step says so.
    if (i.stale !== true) return i.asleep ? { phase: "waking", step: undefined, since: i.asked } : { phase: "received", since: i.asked };
    // An older hub doesn't say when turns end: one that ended while this app was away can't be told from none.
    if (i.idleKnown === true) return { phase: "unstarted" };
  }
  return i.asleep ? { phase: "asleep" } : undefined;
};

/** What the bot shows of its lead's start (botStateOf's `start`): starting, a failed try, or held by the team's billing. */
export const startOf = (w: Wake | undefined): "waking" | "failed" | "held" | undefined =>
  w?.phase === "waking" ? "waking" : w?.phase === "failed" ? "failed" : w?.phase === "held" && w.start === true ? "held" : undefined;

/** The wait shows in the reply's place: from the start until the lead's reply lands, its first words included. */
export const wakeShown = (w: Wake | undefined): boolean => w !== undefined && w.phase !== "asleep";

/** The typing dots beside the bot: while the lead takes your message and works on it, not while it waits or writes. */
export const wakeDots = (w: Wake): boolean => w.phase === "received" || w.phase === "thinking" || w.phase === "working";

/** The bot's pose in the reply's place: still asleep until it stirs, heavy-lidded while its computer starts, eyes open
 * for its files, then the lead's own looks. */
export const wakePose = (w: Wake, stirred: boolean): BotState => {
  if (w.phase === "asleep" || (!stirred && w.phase === "waking")) return "asleep";
  switch (w.phase) {
    case "waking":
      return w.step === "files" || w.step === "session" || w.step === "message" ? "idle" : "waking";
    case "failed":
      return "error";
    case "held":
    case "unstarted":
      return "idle";
    case "received":
    case "thinking":
      return "thinking";
    case "working":
    case "writing":
      return "working";
  }
};

/** Claude's retries in one plain line, by why: overloaded, rate-limited, or not answering. */
export const retryWords = (reason: string): string =>
  reason === "overloaded" ? "Claude is overloaded, retrying…" : reason === "429" ? "Claude is busy (rate-limited), retrying…" : "Claude isn’t answering, retrying…";

/** The word beside the bot (`nowMs` on the hub's clock): the step while its computer starts, "Still waking up" past
 * SLOW_MS (with `count`, the time so far), the reason after a failed try or while something holds the lead, that it
 * waits for the lead to start past START_SLOW_MS, that it didn't start past START_STALE_MS, that Claude isn't serving
 * it past RETRY_SAID_MS of retries; nothing once it thinks. */
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
    case "held":
      return { words: w.reason };
    case "unstarted":
      return { words: "The lead didn’t start on this. Restart it, then send your message again." };
    case "received":
      return w.since !== undefined && nowMs - w.since >= START_SLOW_MS ? { words: "Waiting for the lead to start", count: waited(nowMs - w.since) } : undefined;
    case "working":
      return w.retry !== undefined && nowMs - w.retry.since >= RETRY_SAID_MS ? { words: retryWords(w.retry.reason) } : undefined;
    default:
      return undefined;
  }
};

/** Try again's label: with the seconds until the start tries again by itself, while it waits for that. */
export const tryAgainLabel = (w: Extract<Wake, { phase: "failed" }>, nowMs: number): string => {
  const left = w.retryAt === undefined ? 0 : Math.ceil((w.retryAt - nowMs) / 1000);
  return left > 0 ? `Try again · ${String(left)}s` : "Try again";
};

/**
 * What Try again's press came to, said in the row when it didn't start anything: the hub's own word on why (its
 * `next`, such as the team's billing), "Nothing to retry" when no start was waiting, or why the call failed. Undefined
 * when the start went again: its own steps say so from there.
 */
export const tryAgainNote = (outcome: { readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: { readonly message: string } }): string | undefined => {
  if (!outcome.ok) {
    const why = outcome.error.message.trim().replace(/[.\s]+$/u, "");
    return why === "" ? "Couldn’t try again" : `Couldn’t try again: ${why}`;
  }
  const out = outcome.output as { readonly started?: unknown; readonly next?: unknown } | undefined;
  if (out?.started === true) return undefined;
  return typeof out?.next === "string" && out.next.trim() !== "" ? out.next.trim() : "Nothing to retry";
};

/** Try again's press: the call, and what it came to as tryAgainNote says it; a call that throws says why too. */
export const tryAgainNow = (call: () => Promise<{ readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: { readonly message: string } }>): Promise<string | undefined> =>
  call().then(tryAgainNote, (error: unknown) => tryAgainNote({ ok: false, error: { message: error instanceof Error ? error.message : String(error) } }));

/**
 * What the row's Restart lead came to (project_set leadRestart): it restarts, and the person sends again once it is
 * back; or why it couldn't, in the hub's words.
 */
export const restartNote = (outcome: { readonly ok: true } | { readonly ok: false; readonly error: { readonly message: string } }): string => {
  if (outcome.ok) return "Restarting the lead. Send your message again in a moment.";
  const why = outcome.error.message.trim().replace(/[.\s]+$/u, "");
  return why === "" ? "Couldn’t restart the lead" : `Couldn’t restart the lead: ${why}`;
};

/** "34s", "1m 05s": how long it has waited. */
export const waited = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${String(s)}s` : `${String(Math.floor(s / 60))}m ${String(s % 60).padStart(2, "0")}s`;
};

/**
 * Which bots' current turns began with a start and have no reply yet: a turn is cold from the first `starting` activity
 * seen while its lead works until its reply lands (`replied`), or the lead stops. A lead that goes on working after its
 * reply (reading, briefing agents) is no longer waking: the island and the turn line say what it does, as on any turn.
 * One per app; `see` is told each bot's state as it changes and answers whether its turn is cold.
 */
export class ColdTurns {
  private readonly cold = new Set<string>();
  see(key: string, working: boolean, activity: Activity | undefined, replied = false): boolean {
    if (!working) this.cold.delete(key);
    else if (activity?.kind === "starting") this.cold.add(key);
    else if (replied) this.cold.delete(key);
    return this.cold.has(key);
  }
}

/** When the person's newest message in the chat came (hub epoch ms); undefined before any. Oldest first. */
export const askedAt = (messages: readonly { readonly author: string; readonly createdAt: string }[] | undefined): number | undefined => {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages?.[i];
    if (m?.author === "human") return ms(m.createdAt);
  }
  return undefined;
};

/** The lead's reply has landed: the chat's newest message of the person's or the lead's is the lead's, whole. Oldest
 * first, as the chat holds them. */
export const replied = (messages: readonly { readonly author: string; readonly state: string }[] | undefined): boolean => {
  const last = messages?.findLast((m) => m.author === "human" || m.author === "lead");
  return last !== undefined && last.author === "lead" && last.state === "final";
};

/**
 * Whether the person's newest message has no answer yet, for the bot in the reply's place: one of theirs is on its way
 * (`sending`), or the chat's newest message of the person's or the lead's is theirs, or the lead's reply still
 * streaming after it. Only a lead's whole reply answers it, as the hub's own rule has it (leads/recap.ts `answers`): a
 * line of fleetd's own says something beside it ("The lead restarted on …", a server connected), and a turn that ended
 * on it (a stop, a quiet turn) is wakeOf's (`endedAt`). Oldest first, as the chat holds them.
 */
export const waitingFor = (messages: readonly { readonly author: string; readonly state: string }[] | undefined, sending: boolean): boolean => {
  if (sending) return true;
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages?.[i];
    if (m === undefined || (m.author !== "human" && m.author !== "lead")) continue;
    if (m.author === "lead" && m.state === "streaming") continue;
    return m.author === "human";
  }
  return false;
};

/** When the lead was last seen to stop (hub epoch ms): the later of the hub's leadIdleAt and a stop this app saw live. */
export const endedAt = (leadIdleAt: string | undefined, seen: number | undefined): number | undefined => {
  const hub = ms(leadIdleAt);
  return hub === undefined ? seen : seen === undefined ? hub : Math.max(hub, seen);
};

/** What holds the lead up, in one short line: the hub's word on why it doesn't have your message (its first sentence),
 * or why the bot is blocked (its machine offline, its usage paused). Undefined when there is none. */
export const heldWords = (why: { readonly leadWaiting?: string | undefined; readonly blocked?: string | undefined }): string | undefined => {
  if (why.leadWaiting !== undefined) {
    const said = why.leadWaiting.trim();
    return said === "" ? undefined : (said.match(/^.+?[.!?](?=\s|$)/u)?.[0] ?? said);
  }
  const reason = why.blocked?.trim().replace(/[.\s]+$/u, "");
  return reason === undefined ? undefined : reason === "" ? "The lead can’t start now." : `The lead can’t start now: ${reason}.`;
};
