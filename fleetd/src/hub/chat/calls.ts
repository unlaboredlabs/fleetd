// The chat's lead calls: the lead's `nudge`, and a project reading back through its
// own chat with `chat_search` and `chat_read`. The search reads the chats' index (find.ts), as a person's does: each
// word from the start of a word; the chat is always the caller's own project's, so another chat is never read.
import type { ChatAuthor, ChatMessage, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { leadCalls, type LeadCaller } from "../leads/seams.ts";
import { mayUse } from "../project_lead/bridge.ts";
import { parseMs } from "../store/time.ts";
import { leadThread } from "./flow.ts";
import { leadSource } from "./history.ts";
import { chat } from "./index.ts";

/** Hits `chat_search` returns per page, newest first. */
export const CHAT_SEARCH_PAGE = 20;
/** The characters of a hit `chat_search` shows, around the first of its words. */
const HIT_CHARS = 300;
/** The characters of each message `chat_read` shows, unless it reads one message alone. */
const READ_CHARS = 2000;
/** Messages `chat_read` reads on each side when not told. */
const SIDE = 5;
const SIDE_MAX = 10;

export type RecalledMessage = { messageId: string; at: string; author: ChatAuthor; by?: string; text: string; cut?: true };

export function registerLeadCalls(hub: Hub): void {
  const calls = leadCalls(hub);
  calls.register("nudge", (caller, call) => nudge(hub, caller, call));
  for (const op of ["chat_search", "chat_read"]) calls.register(op, (caller, call) => recall(hub, caller, call));
}

/**
 * The lead's `nudge`: flags the message its turn ends with, which posts as the turn ends (history's `leadMessages`):
 * nothing of a turn is in the chat while it runs. A turn that ends with QUIET flags nothing (flow's `mirror`).
 */
export function nudge(hub: Hub, caller: LeadCaller, call: Record<string, unknown>) {
  if (caller.agent.kind !== "lead") throw new ToolError("forbidden", "Only a bot's lead nudges, and only its own messages.");
  const reason = typeof call.reason === "string" ? call.reason : "";
  if ([...reason].length < 1 || [...reason].length > 200 || /[\r\n]/.test(reason)) {
    throw new ToolError("invalid", "reason: give what to look at in a few words, on one line, at most 200 characters.");
  }
  const thread = leadThread(hub, caller.projectRef);
  if (!thread) throw new ToolError("invalid", "Your bot has no lead session to flag a message of.");
  chat(hub).nudgeOnLanding(leadSource(thread.threadId, ""), reason);
  return { next: "Flagged: the message you end this turn with shows as something to look at once it is in the chat. Write it last, after every tool call." };
}

function recall(hub: Hub, caller: LeadCaller, call: Record<string, unknown> & { op: string }) {
  mayUse(hub.db.conn, caller.projectRef);
  if (caller.agent.kind !== "lead") {
    throw new ToolError("forbidden", "Only the lead itself reads back through its chat.", "The person reads the chat in the app.");
  }
  if (call.op === "chat_search") return search(hub, caller, call);
  if (call.op === "chat_read") return read(hub, caller, call);
  throw new ToolError("invalid", `${call.op} is not a chat recall call.`);
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function search(hub: Hub, caller: LeadCaller, call: Record<string, unknown>) {
  const r = caller.projectRef;
  const words = (str(call.words) ?? "").split(/\s+/u).filter(Boolean);
  if (words.length === 0) throw new ToolError("invalid", "Give at least one word to look for.");
  const from = str(call.from) === undefined ? undefined : when(str(call.from) as string, false);
  const to = str(call.to) === undefined ? undefined : when(str(call.to) as string, true);
  const before = str(call.before) === undefined ? undefined : ownSeq(hub, r, str(call.before) as string);
  const { messages: found, more } = chat(hub).search(r, words, from, to, before, CHAT_SEARCH_PAGE);
  const messages = found.map((m) => recalled(m, words, HIT_CHARS));
  const last = messages[messages.length - 1];
  const next = !last
    ? before !== undefined
      ? "No older messages hold all of those words."
      : "Nothing in the chat holds all of those words. Try fewer or other words, or a wider date range."
    : more
      ? `Older hits are left: call chat_search again with before: "${last.messageId}". chat_read with a messageId reads the messages around one.`
      : "chat_read with a messageId reads the messages around one.";
  return { messages, ...(more ? { more: true } : {}), next };
}

function side(v: unknown, name: string): number {
  if (v === undefined || v === null) return SIDE;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > SIDE_MAX) throw new ToolError("invalid", `${name}: expected a whole number from 0 to ${SIDE_MAX}`);
  return v;
}

function read(hub: Hub, caller: LeadCaller, call: Record<string, unknown>) {
  const r = caller.projectRef;
  const seq = ownSeq(hub, r, str(call.messageId) ?? "");
  const before = side(call.before, "before");
  const after = side(call.after, "after");
  const { messages: found, moreBefore, moreAfter } = chat(hub).around(r, seq, before, after);
  // One message alone reads whole.
  const max = before === 0 && after === 0 ? Number.POSITIVE_INFINITY : READ_CHARS;
  const messages = found.map((m) => recalled(m, [], max));
  return {
    messages,
    moreBefore,
    moreAfter,
    ...(moreBefore || moreAfter ? { next: "chat_read again with the first message's id and before, or the last one's and after, reads further." } : {}),
  };
}

/** The seq of message `id` in the caller's own chat; any other chat's message is refused as unknown. */
function ownSeq(hub: Hub, r: ProjectRef, id: string): number {
  const seq = chat(hub).seqIn(r, id);
  if (seq === undefined) throw new ToolError("not_found", `${id} is not a message of this chat.`, "Use a messageId chat_search returned.");
  return seq;
}

/** A date (2026-10-20, in UTC: its start, or with `end` its last moment) or a time, as ms. */
export function when(text: string, end: boolean): number {
  const t = text.trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (day) {
    const start = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    const valid = new Date(start).toISOString().slice(0, 10) === t;
    if (valid) return end ? start + 86_400_000 - 1 : start;
  }
  const ms = parseMs(t);
  if (ms === undefined) throw new ToolError("invalid", `${t} is not a date or a time.`, "Give a day, 2026-10-20, or a time, 2026-10-20T09:00:00Z.");
  return ms;
}

function recalled(m: ChatMessage, words: string[], max: number): RecalledMessage {
  const [text, cut] = excerpt(m.text, words, max);
  return { messageId: m.messageId, at: m.createdAt, author: m.author, ...(m.by !== undefined ? { by: m.by } : {}), text, ...(cut ? { cut: true } : {}) };
}

/** At most `max` characters of `text`, starting a little before the first of `words` it holds, and whether it was cut. */
export function excerpt(text: string, words: string[], max: number): [string, boolean] {
  const chars = [...text];
  const total = chars.length;
  if (total <= max) return [text, false];
  const lower = text.toLowerCase();
  // Lowercasing that changes a text's length would move the hit: read it from the start then.
  let hit = 0;
  if (lower.length === text.length) {
    const found = words.map((w) => lower.indexOf(w.toLowerCase())).filter((i) => i >= 0);
    if (found.length > 0) hit = [...text.slice(0, Math.min(...found))].length;
  }
  const start = Math.min(Math.max(0, hit - Math.floor(max / 3)), Math.max(0, total - max));
  let out = chars.slice(start, start + max).join("");
  if (start > 0) out = `…${out}`;
  if (start + max < total) out += "…";
  return [out, true];
}
