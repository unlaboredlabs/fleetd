// The daily check-in, kept pure: a watcher of kind `checkin`, one per bot and off until a person switches it on in the
// bot's settings. Once a day, at 09:00 in the zone it was switched on in, the hub reads what may wait (open orders that
// stalled, requests that wait on a person, follow-ups the lead promised in the chat); a day with none of them, or with
// the same ones as the last look, starts no session and posts nothing. Otherwise a session with no tools turns them
// into at most one short offer, which goes in the chat as a lead message with buttons (`offerText`). It only offers:
// nothing starts until the person taps a button, which is their own message to the lead (`answeredOffer` ties it to
// the offer, so the lead reads what it answers). index.ts reads the hub and posts.
import type { AutomationWatch } from "../../shared/contracts.ts";
import { isoMs, parseMs } from "../store/time.ts";
import type { Evidence } from "./rules.ts";

export const CHECKIN = "checkin";
export const CHECKIN_NAME = "Daily check-in";
/** The check-in's one frequency: daily, at 09:00 in its zone (`EVERY_CRON.day`). */
export const CHECKIN_WATCH: AutomationWatch = { kind: CHECKIN, every: "day" };
/** An open order with nothing of it in flight, untouched this long, has stalled. */
export const STALL_MS = 24 * 3_600_000;
/** A request waiting on a person this long is worth a word; a newer one they are likely on. */
export const WAIT_MS = 3_600_000;
/** How far back the lead's promises are read. */
export const PROMISE_MS = 3 * 24 * 3_600_000;
/** Each kind of fact the session reads, at most. */
const LISTED = 8;
/** The offer's words and each button's, at most, in characters. */
export const TEXT_MAX = 300;
export const OPTION_MAX = 40;
/** Buttons the session gives, at most; fleetd adds Not now. */
export const OPTIONS_MAX = 3;
export const NOT_NOW = "Not now";
/** The source its posted offers carry (`chat_messages.source`): one per run. */
export const OFFER_SOURCE = "checkin:";

export const isCheckIn = (w: AutomationWatch | undefined) => w?.kind === CHECKIN;

/** An open order whose work stopped moving: its title, and when anything of it last changed. */
export type Stalled = { id: string; title: string; since: string };
/** A request that waits on a person: an approval or a secret, with its one line. */
export type Waiting = { id: string; kind: string; text: string; at: string };
/** A lead message that promised a later step. */
export type Promised = { id: string; text: string; at: string };
/** What the check-in reads, and the orders closed lately, so a promise already kept reads as kept. */
export type CheckInFacts = { stalled: Stalled[]; waiting: Waiting[]; promised: Promised[]; closed: string[] };

/** Words that promise a later step: "I'll check back Friday", "I can follow up tomorrow". */
const PROMISE =
  /\b(check back|check in again|follow[- ]up|get back to you|circle back|look again|revisit|remind you|tomorrow|next week|later today|this evening|on (mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;

/** Whether a lead message promises a later step. */
export const promises = (text: string) => PROMISE.test(text);

const oneLine = (s: string, max: number) => {
  const chars = [...s.split(/\s+/).filter(Boolean).join(" ")];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

/** "Tue 24 Nov, 2 d ago": a fact's time as the session reads it. */
function ago(now: number, at: string): string {
  const ms = parseMs(at);
  if (ms === undefined) return at;
  const h = Math.max(0, Math.round((now - ms) / 3_600_000));
  return `${isoMs(ms).slice(0, 16).replace("T", " ")} UTC, ${h < 48 ? `${h} h` : `${Math.round(h / 24)} d`} ago`;
}

/**
 * The check-in's evidence, undefined on a quiet day: nothing stalled, waiting or promised. Its key is the same while
 * the same things wait, so a day like the last one asks nothing again.
 */
export function checkInEvidence(f: CheckInFacts, now: number): Evidence | undefined {
  if (f.stalled.length + f.waiting.length + f.promised.length === 0) return undefined;
  const lines: string[] = [];
  const list = <T>(head: string, items: T[], line: (x: T) => string) => {
    if (items.length === 0) return;
    lines.push(head, ...items.slice(0, LISTED).map((x) => `- ${line(x)}`));
    if (items.length > LISTED) lines.push(`- and ${items.length - LISTED} more`);
  };
  list("Open orders whose work stopped moving (no agent running, nothing on the merge train):", f.stalled, (s) => `"${oneLine(s.title, 120)}", last changed ${ago(now, s.since)}`);
  list("Waiting on the person:", f.waiting, (w) => `${w.kind === "secret" ? "a secret to enter" : "an approval"}: "${oneLine(w.text, 160)}", asked ${ago(now, w.at)}`);
  list("Follow-ups you promised in the chat:", f.promised, (p) => `"${oneLine(p.text, 300)}", said ${ago(now, p.at)}`);
  if (f.closed.length > 0) lines.push(`Orders closed since then: ${f.closed.slice(0, LISTED).map((t) => `"${oneLine(t, 80)}"`).join(", ")}.`);
  const key = [...f.stalled.map((s) => `s:${s.id}`), ...f.waiting.map((w) => `w:${w.id}`), ...f.promised.map((p) => `p:${p.id}`)].sort().join("\n");
  return { text: lines.join("\n"), key };
}

/** The check-in session's message: who it speaks as, what was read, and how it answers. */
export function checkInMessage(bot: string, evidence: Evidence): string {
  return [
    `You are the lead of the bot "${oneLine(bot, 80)}", doing your daily check-in with the person. You have no tools, change nothing and start nothing: you only offer. The person decides.`,
    `What fleetd read in the bot just now:\n${evidence.text}`,
    "Pick what you could usefully pick up or move along for them: restart or finish stalled work, remind them of what waits on them, or do a follow-up you promised. Leave out anything that already looks handled, and anything not worth their time.",
    "End with one line and nothing after it. OK when nothing is worth offering. Otherwise a JSON object on that line: " +
      `{"text": "...", "options": ["..."]}. text: at most ${TEXT_MAX} characters, in your own voice and plain words, no markdown, ` +
      "no links and no ids such as W12 or T3, ending with a question, such as \"Two things I can pick up: the login fix stalled " +
      'on Tuesday, and I said I\'d check the pricing page again. Want me to?". ' +
      `options: the buttons they tap, 1 to ${OPTIONS_MAX}, each at most ${OPTION_MAX} characters, each a yes to one offer ` +
      '("Finish the login fix"); with two offers or more, the first takes them all ("Do both"). Leave out a no: fleetd adds Not now.',
  ].join("\n\n");
}

/** The offer a session's answer makes: undefined for OK, a string saying why for an answer that isn't one. */
export function offerOf(answer: string | undefined): { text: string; options: string[] } | undefined | string {
  const lines = (answer ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  if (last === undefined) return "It ended without an answer.";
  if (/^ok$/i.test(last.replace(/^[*_`#>\s-]+|[*_`.!\s]+$/g, ""))) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(last.replace(/^`+(json)?|`+$/g, ""));
  } catch {
    return "Its answer was neither OK nor an offer.";
  }
  const v = value as { text?: unknown; options?: unknown } | null;
  if (v === null || typeof v !== "object" || typeof v.text !== "string" || !Array.isArray(v.options)) return "Its offer had no text or buttons.";
  const text = oneLine(v.text, TEXT_MAX);
  const seen = new Set([NOT_NOW.toLowerCase()]);
  const options: string[] = [];
  for (const o of v.options) {
    if (typeof o !== "string") continue;
    const label = oneLine(o, OPTION_MAX);
    if (label === "" || seen.has(label.toLowerCase()) || options.length >= OPTIONS_MAX) continue;
    seen.add(label.toLowerCase());
    options.push(label);
  }
  if (text === "" || options.length === 0) return "Its offer had no text or buttons.";
  return { text, options };
}

/** The offer as the lead message the chat shows: one ask block, its question the offer, its buttons, then Not now. */
export function offerText(offer: { text: string; options: string[] }): string {
  const block = { v: 1, kind: "ask", question: offer.text, options: [...offer.options, NOT_NOW] };
  return `\`\`\`fleetd-block\n${JSON.stringify(block)}\n\`\`\``;
}

/** The buttons of an offer's text, or undefined when it isn't one. */
export function offerOptions(text: string): string[] | undefined {
  const m = /^```fleetd-block\n(\{.*\})\n```$/s.exec(text);
  if (!m) return undefined;
  try {
    const b = JSON.parse(m[1] as string) as { kind?: unknown; options?: unknown };
    return b.kind === "ask" && Array.isArray(b.options) ? b.options.filter((o): o is string => typeof o === "string") : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `text`, a person's message, is one of an offer's buttons. */
export const tapped = (options: readonly string[], text: string) => options.some((o) => o.trim().toLowerCase() === text.trim().toLowerCase());
