// A Navi reads back through its own chat (crates/fleetd/src/hub/navi/recall.rs): `chat_search` finds the messages
// holding some words, in a date range or not, newest first and a page at a time, and `chat_read` reads the messages
// around one of them. A fresh session sees only the latest part of the chat; these reach all of it.
//
// Plain text matching over the stored chat (`chat(hub).search`), nothing more. Only a project's own lead makes these
// calls: the chat is always the caller's own project's, and a message id from another chat is refused.
import type { ChatMessage } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { chat } from "../chat/index.ts";
import { leadCalls } from "../lead_calls/index.ts";
import type { LeadCall, LeadCaller } from "../lead_calls/types.ts";
import { parseMs } from "../store/time.ts";
import { mayUse } from "./bridge.ts";

export const OPS = ["chat_search", "chat_read"] as const;
/** The hits `chat_search` returns at once (fleetd-contracts navi.rs `CHAT_SEARCH_PAGE`). */
export const CHAT_SEARCH_PAGE = 20;
/** The most messages `chat_read` reads on each side. */
export const CHAT_READ_SIDE_MAX = 10;
/** The characters of a hit `chat_search` shows, around the first of its words. */
const HIT_CHARS = 300;
/** The characters of each message `chat_read` shows, unless it reads one message alone. */
const READ_CHARS = 2000;
/** Messages `chat_read` reads on each side when not told. */
const SIDE = 5;

/** One message as the recall calls show it (navi.rs `RecalledMessage`). */
export type RecalledMessage = { messageId: string; at: string; author: string; by?: string; text: string; cut?: boolean };

export function start(hub: Hub): void {
  for (const op of OPS) leadCalls(hub).register(op, (caller, call) => answer(hub, caller, call));
}

const failed = (error: unknown) => {
  console.error(`navi recall store: ${(error as Error).message}`);
  return new ToolError("failed", "The hub failed to read the chat.");
};

/** The store's answer, a store failure as the call's. */
function stored<T>(f: () => T): T {
  try {
    return f();
  } catch (error) {
    throw failed(error);
  }
}

export function answer(hub: Hub, caller: LeadCaller, call: LeadCall): Record<string, unknown> {
  mayUse(hub.db.conn, caller.projectRef);
  if (caller.agent.kind !== "lead") {
    throw new ToolError("forbidden", "Only the lead itself reads back through its chat.", "The person reads the chat in the app.");
  }
  if (call.op === "chat_search") return search(hub, caller, call);
  if (call.op === "chat_read") return read(hub, caller, call);
  throw new ToolError("invalid", `${call.op} is not a chat recall call.`);
}

const lineOf = (v: unknown, min: number, max: number): v is string =>
  typeof v === "string" && v.length >= min && v.length <= max && !/[\r\n]/.test(v);

function invalid(field: string, why: string): never {
  throw new ToolError("invalid", `${field}: ${why}`);
}

function search(hub: Hub, caller: LeadCaller, call: LeadCall): Record<string, unknown> {
  const r = caller.projectRef;
  if (!lineOf(call.words, 1, 200)) invalid("words", "expected a single line of 1 to 200 characters");
  for (const k of ["from", "to"] as const) if (call[k] != null && !lineOf(call[k], 10, 40)) invalid(k, "expected a date or a time");
  if (call.before != null && typeof call.before !== "string") invalid("before", "expected a message id");
  const words = (call.words as string).split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new ToolError("invalid", "Give at least one word to look for.");
  const from = typeof call.from === "string" ? when(call.from, false) : undefined;
  const to = typeof call.to === "string" ? when(call.to, true) : undefined;
  const before = typeof call.before === "string" ? ownSeq(hub, caller, call.before) : undefined;
  const { messages: found, more } = stored(() => chat(hub).search(r, words, from, to, before, CHAT_SEARCH_PAGE));
  const messages = found.map((m) => recalled(m, words, HIT_CHARS));
  const last = messages.at(-1);
  let next: string;
  if (!last) {
    next =
      before !== undefined
        ? "No older messages hold all of those words."
        : "Nothing in the chat holds all of those words. Try fewer or other words, or a wider date range.";
  } else if (more) {
    next =
      `Older hits are left: call chat_search again with before: "${last.messageId}". chat_read with a messageId reads ` +
      "the messages around one.";
  } else next = "chat_read with a messageId reads the messages around one.";
  return { messages, ...(more ? { more: true } : {}), next };
}

function read(hub: Hub, caller: LeadCaller, call: LeadCall): Record<string, unknown> {
  if (typeof call.messageId !== "string") invalid("messageId", "expected a message id");
  const side = (k: "before" | "after") => {
    const v = call[k];
    if (v == null) return SIDE;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > CHAT_READ_SIDE_MAX) invalid(k, `expected a whole number from 0 to ${CHAT_READ_SIDE_MAX}`);
    return v;
  };
  const before = side("before");
  const after = side("after");
  const seq = ownSeq(hub, caller, call.messageId as string);
  const { messages: found, moreBefore, moreAfter } = stored(() => chat(hub).around(caller.projectRef, seq, before, after));
  // One message alone reads whole.
  const max = before === 0 && after === 0 ? Number.MAX_SAFE_INTEGER : READ_CHARS;
  return {
    messages: found.map((m) => recalled(m, [], max)),
    moreBefore,
    moreAfter,
    ...(moreBefore || moreAfter
      ? { next: "chat_read again with the first message's id and before, or the last one's and after, reads further." }
      : {}),
  };
}

/** The seq of message `id` in the caller's own chat; any other chat's message is refused as unknown. */
function ownSeq(hub: Hub, caller: LeadCaller, id: string): number {
  const seq = stored(() => chat(hub).seqIn(caller.projectRef, id));
  if (seq === undefined) throw new ToolError("not_found", `${id} is not a message of this chat.`, "Use a messageId chat_search returned.");
  return seq;
}

/** A date (2026-10-20, in UTC: its start, or with `end` its last moment) or a time, as ms. */
export function when(text: string, end: boolean): number {
  const t = text.trim();
  const day = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
    const start = Date.UTC(y, m - 1, d);
    const back = new Date(start);
    if (back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d) return end ? start + 86_400_000 - 1 : start;
  }
  const ms = parseMs(t);
  if (ms === undefined) {
    throw new ToolError("invalid", `${t} is not a date or a time.`, "Give a day, 2026-10-20, or a time, 2026-10-20T09:00:00Z.");
  }
  return ms;
}

function recalled(m: ChatMessage, words: string[], max: number): RecalledMessage {
  const [text, cut] = excerpt(m.text, words, max);
  return {
    messageId: m.messageId,
    at: m.createdAt,
    author: m.author,
    ...(m.by !== undefined ? { by: String(m.by) } : {}),
    text,
    ...(cut ? { cut: true } : {}),
  };
}

/** At most `max` characters of `text`, starting a little before the first of `words` it holds, and whether it was cut. */
export function excerpt(text: string, words: string[], max: number): [string, boolean] {
  const chars = [...text];
  const total = chars.length;
  if (total <= max) return [text, false];
  const lower = text.toLowerCase();
  // Lowercasing that changes a text's length would move the hit: read it from the start then.
  let hit = 0;
  if (Buffer.byteLength(lower) === Buffer.byteLength(text) && lower.length === text.length) {
    const at = words.map((w) => lower.indexOf(w.toLowerCase())).filter((i) => i >= 0);
    if (at.length > 0) hit = [...text.slice(0, Math.min(...at))].length;
  }
  const start = Math.min(Math.max(0, hit - Math.floor(max / 3)), Math.max(0, total - max));
  let out = chars.slice(start, start + max).join("");
  if (start > 0) out = `…${out}`;
  if (start + max < total) out += "…";
  return [out, true];
}
