// What this phone keeps about its chats, as Telegram does per device: which are pinned (in the order pinned), which
// are muted, how far each was read, and which were marked unread by hand. The hub knows none of it. Pure, so it is
// unit-tested; prefsStore.ts keeps it on disk.
import type { ChatMessage } from "./desktop";
import type { Key } from "./store";

export interface Prefs {
  /** Pinned chats, the first pinned first. */
  readonly pinned: readonly Key[];
  readonly muted: readonly Key[];
  /** The newest seq read, by chat. A chat with none yet counts as read up to what it held when first seen. */
  readonly read: Readonly<Record<Key, number>>;
  /** Marked unread by hand: a dot, until the chat is opened. */
  readonly unread: readonly Key[];
}

export const noPrefs: Prefs = { pinned: [], muted: [], read: {}, unread: [] };

export const MAX_PINNED = 5;

const toggle = (keys: readonly Key[], key: Key, on: boolean): readonly Key[] => (keys.includes(key) === on ? keys : on ? [...keys, key] : keys.filter((k) => k !== key));

export type PrefsAction =
  | { readonly t: "pin"; readonly key: Key; readonly on: boolean }
  | { readonly t: "mute"; readonly key: Key; readonly on: boolean }
  /** Read up to `seq`: the chat was open with it on screen. */
  | { readonly t: "read"; readonly key: Key; readonly seq: number }
  | { readonly t: "unread"; readonly key: Key }
  /** Chats seen for the first time count as read up to what they hold. */
  | { readonly t: "seen"; readonly lastSeqs: Readonly<Record<Key, number>> };

export const reducePrefs = (p: Prefs, a: PrefsAction): Prefs => {
  switch (a.t) {
    case "pin":
      if (a.on && !p.pinned.includes(a.key) && p.pinned.length >= MAX_PINNED) return p;
      return { ...p, pinned: toggle(p.pinned, a.key, a.on) };
    case "mute":
      return { ...p, muted: toggle(p.muted, a.key, a.on) };
    case "read": {
      const unread = toggle(p.unread, a.key, false);
      if ((p.read[a.key] ?? -1) >= a.seq && unread === p.unread) return p;
      return { ...p, read: { ...p.read, [a.key]: Math.max(a.seq, p.read[a.key] ?? 0) }, unread };
    }
    case "unread":
      return { ...p, unread: toggle(p.unread, a.key, true) };
    case "seen": {
      const fresh = Object.entries(a.lastSeqs).filter(([k]) => p.read[k] === undefined);
      return fresh.length === 0 ? p : { ...p, read: { ...p.read, ...Object.fromEntries(fresh) } };
    }
  }
};

/** Read back from disk: anything that isn't a Prefs' shape is dropped, field by field. */
export const parsePrefs = (raw: unknown): Prefs => {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const keys = (v: unknown): Key[] => (Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : []);
  const read = typeof o.read === "object" && o.read !== null ? Object.entries(o.read).filter((e): e is [string, number] => typeof e[1] === "number") : [];
  return { pinned: keys(o.pinned).slice(0, MAX_PINNED), muted: keys(o.muted), read: Object.fromEntries(read), unread: keys(o.unread) };
};

/**
 * How many messages from the other side came after what was read: those the phone holds, plus any newer it hasn't
 * read (the chat's last seq is past them). Your own don't count, nor anything when the chat is unknown here.
 */
export const unreadCount = (p: Prefs, key: Key, lastSeq: number | undefined, messages: readonly Pick<ChatMessage, "seq" | "author">[]): number => {
  const read = p.read[key];
  if (read === undefined || lastSeq === undefined || lastSeq <= read) return 0;
  const after = messages.filter((m) => m.seq > read);
  const theirs = after.filter((m) => m.author !== "human").length;
  const newest = after.reduce((n, m) => Math.max(n, m.seq), read);
  // The hub's seq counts every message: those past what's held are counted as they may be the lead's.
  const unheld = Math.max(0, lastSeq - newest);
  // Yours, newest of all: you've read what came before it.
  const lastMine = after.findLast((m) => m.author === "human");
  if (lastMine !== undefined && unheld === 0) return after.filter((m) => m.seq > lastMine.seq && m.author !== "human").length;
  return theirs + unheld;
};
