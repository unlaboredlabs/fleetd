// What this phone keeps about its chats, as chat apps do per device: which are muted, how far each was read, and
// which were marked unread by hand, which the hub knows none of; and its copy of the person's pinned chats on each hub,
// which the hub keeps (pins.ts), and of their sections of chats (sections.ts), with which of those are folded here.
// Pure, so it is unit-tested; prefsStore.ts keeps it on disk.
import type { ChatMessage } from "./desktop";
import type { PinStore } from "./pins";
import type { Section, SectionStore } from "./sections";
import type { Key } from "./store";

/** A hub, by the origin the phone connects to (Paired.hub). */
export type HubOrigin = string;

export interface Prefs {
  /** Pinned chats by hub, in the person's order: this phone's copy of each hub's (pins.ts). */
  readonly pins: Readonly<Record<HubOrigin, readonly Key[]>>;
  /** Hubs whose pins changed here and haven't been taken by the hub yet: sent on its next live link. */
  readonly pinsPending: readonly HubOrigin[];
  /**
   * Pinned before the hubs kept them, by an older build, for whichever hub it was paired with: a hub without pins of
   * its own shows these, and claims those of its own chats once (pins.ts).
   */
  readonly legacyPinned: readonly Key[];
  /** The person's sections of chats by hub, in their order: this phone's copy of each hub's (sections.ts). */
  readonly sections: Readonly<Record<HubOrigin, readonly Section[]>>;
  /** Hubs whose sections changed here and haven't been taken by the hub yet: sent on its next live link. */
  readonly sectionsPending: readonly HubOrigin[];
  /** The sections folded to their label on this phone, by id. */
  readonly folded: readonly string[];
  readonly muted: readonly Key[];
  /** The newest seq read, by chat. A chat with none yet counts as read up to what it held when first seen. */
  readonly read: Readonly<Record<Key, number>>;
  /** Marked unread by hand: a dot, until the chat is opened. */
  readonly unread: readonly Key[];
}

export const noPrefs: Prefs = { pins: {}, pinsPending: [], legacyPinned: [], sections: {}, sectionsPending: [], folded: [], muted: [], read: {}, unread: [] };

/** The pins this phone shows for `hub`: its own, else the ones from before the hubs kept them. */
export const pinsOf = (p: Prefs, hub: HubOrigin): readonly Key[] => p.pins[hub] ?? p.legacyPinned;

/** One hub's pins in the phone's prefs, as its session keeps them (pins.ts PinStore): nothing of another hub's. */
export const hubPinStore = (get: () => Prefs, dispatch: (a: PrefsAction) => void, hub: HubOrigin): PinStore => ({
  saved: () => pinsOf(get(), hub),
  save: (keys) => dispatch({ t: "pins", hub, keys }),
  pending: () => get().pinsPending.includes(hub),
  setPending: (on) => dispatch({ t: "pinsPending", hub, on }),
});

const NO_SECTIONS: readonly Section[] = [];

/** The sections this phone shows for `hub`. */
export const sectionsOf = (p: Prefs, hub: HubOrigin): readonly Section[] => p.sections[hub] ?? NO_SECTIONS;

/** One hub's sections in the phone's prefs, as its session keeps them (sections.ts SectionStore). */
export const hubSectionStore = (get: () => Prefs, dispatch: (a: PrefsAction) => void, hub: HubOrigin): SectionStore => ({
  saved: () => sectionsOf(get(), hub),
  save: (sections) => dispatch({ t: "sections", hub, sections }),
  pending: () => get().sectionsPending.includes(hub),
  setPending: (on) => dispatch({ t: "sectionsPending", hub, on }),
});

/** The most chats pinned, as Messages allows: the hub's CHAT_PINS_MAX. */
export const MAX_PINNED = 9;

/** The pins with `key` pinned (last) or unpinned; null when it can't be pinned, as the most are. */
export const togglePin = (pinned: readonly Key[], key: Key, on: boolean): readonly Key[] | null =>
  on && !pinned.includes(key) && pinned.length >= MAX_PINNED ? null : toggle(pinned, key, on);

const toggle = (keys: readonly Key[], key: Key, on: boolean): readonly Key[] => (keys.includes(key) === on ? keys : on ? [...keys, key] : keys.filter((k) => k !== key));

export type PrefsAction =
  /** A hub's pins as they are now: pinned or moved here, or read from the hub. */
  | { readonly t: "pins"; readonly hub: HubOrigin; readonly keys: readonly Key[] }
  /** A hub's pins changed here and wait to be sent (on), or the hub took them (off). */
  | { readonly t: "pinsPending"; readonly hub: HubOrigin; readonly on: boolean }
  /** A hub's sections as they are now: changed here, or read from the hub. */
  | { readonly t: "sections"; readonly hub: HubOrigin; readonly sections: readonly Section[] }
  /** A hub's sections changed here and wait to be sent (on), or the hub took them (off). */
  | { readonly t: "sectionsPending"; readonly hub: HubOrigin; readonly on: boolean }
  /** A section folded to its label (on) or opened again, on this phone. */
  | { readonly t: "fold"; readonly id: string; readonly on: boolean }
  | { readonly t: "mute"; readonly key: Key; readonly on: boolean }
  /** Read up to `seq`: the chat was open with it on screen. */
  | { readonly t: "read"; readonly key: Key; readonly seq: number }
  | { readonly t: "unread"; readonly key: Key }
  /** Chats seen for the first time count as read up to what they hold. */
  | { readonly t: "seen"; readonly lastSeqs: Readonly<Record<Key, number>> };

export const reducePrefs = (p: Prefs, a: PrefsAction): Prefs => {
  switch (a.t) {
    case "pins": {
      const keys = [...new Set(a.keys)].slice(0, MAX_PINNED);
      const was = p.pins[a.hub];
      return was !== undefined && keys.length === was.length && keys.every((k, i) => was[i] === k) ? p : { ...p, pins: { ...p.pins, [a.hub]: keys } };
    }
    case "pinsPending": {
      const pending = toggle(p.pinsPending, a.hub, a.on);
      return pending === p.pinsPending ? p : { ...p, pinsPending: pending };
    }
    case "sections": {
      const was = p.sections[a.hub];
      return was !== undefined && sameSections(was, a.sections) ? p : { ...p, sections: { ...p.sections, [a.hub]: a.sections } };
    }
    case "sectionsPending": {
      const pending = toggle(p.sectionsPending, a.hub, a.on);
      return pending === p.sectionsPending ? p : { ...p, sectionsPending: pending };
    }
    case "fold": {
      const folded = toggle(p.folded, a.id, a.on);
      return folded === p.folded ? p : { ...p, folded };
    }
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

const sameSections = (a: readonly Section[], b: readonly Section[]): boolean =>
  a.length === b.length &&
  a.every((s, i) => {
    const o = b[i];
    return o !== undefined && s.id === o.id && s.name === o.name && s.chats.length === o.chats.length && s.chats.every((k, j) => k === o.chats[j]);
  });

/** Read back from disk: anything that isn't a Prefs' shape is dropped, field by field. */
export const parsePrefs = (raw: unknown): Prefs => {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const keys = (v: unknown): Key[] => (Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : []);
  const read = typeof o.read === "object" && o.read !== null ? Object.entries(o.read).filter((e): e is [string, number] => typeof e[1] === "number") : [];
  const pins = typeof o.pins === "object" && o.pins !== null && !Array.isArray(o.pins) ? Object.entries(o.pins).map(([hub, k]) => [hub, keys(k).slice(0, MAX_PINNED)] as const) : [];
  const section = (v: unknown): Section[] => {
    const s = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
    return typeof s.id === "string" && typeof s.name === "string" ? [{ id: s.id, name: s.name, chats: keys(s.chats) }] : [];
  };
  const sections = typeof o.sections === "object" && o.sections !== null && !Array.isArray(o.sections) ? Object.entries(o.sections).map(([hub, v]) => [hub, Array.isArray(v) ? v.flatMap(section) : []] as const) : [];
  return {
    pins: Object.fromEntries(pins),
    pinsPending: keys(o.pinsPending),
    // An older build's `pinned`: one list, for the hub it was paired with.
    legacyPinned: keys(o.legacyPinned ?? o.pinned).slice(0, MAX_PINNED),
    sections: Object.fromEntries(sections),
    sectionsPending: keys(o.sectionsPending),
    folded: keys(o.folded),
    muted: keys(o.muted),
    read: Object.fromEntries(read),
    unread: keys(o.unread),
  };
};

/**
 * How many messages from the other side came after what was read: those the phone holds, plus every newer one it
 * doesn't hold (the hub's seq counts every message, so the seqs between are counted as they may be the lead's), before
 * and after what it holds. Your own don't count, nor what came before your newest (you'd read it to answer), nor
 * anything when the chat is unknown here.
 */
export const unreadCount = (p: Prefs, key: Key, lastSeq: number | undefined, messages: readonly Pick<ChatMessage, "seq" | "author">[]): number => {
  const read = p.read[key];
  if (read === undefined || lastSeq === undefined || lastSeq <= read) return 0;
  const after = messages.filter((m) => m.seq > read);
  const from = after.findLast((m) => m.author === "human")?.seq ?? read;
  const held = after.filter((m) => m.seq > from);
  const unheld = Math.max(0, lastSeq - from - held.filter((m) => m.seq <= lastSeq).length);
  return held.length + unheld;
};
