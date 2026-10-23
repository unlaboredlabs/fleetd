// What the person last looked at in each project's chat: the newest message seq it showed. The sidebar sets a
// project bold while its chat has a newer one. It is this app's own memory, not the hub's, so it lives in
// localStorage, kept across launches.
import { useSyncExternalStore } from "react";

export type Seen = Readonly<Record<string, number>>;

const KEY = "fleetd.seenChats";

const read = (): Seen => {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number"));
  } catch {
    return {};
  }
};

let seen: Seen | undefined;
const listeners = new Set<() => void>();

const current = (): Seen => (seen ??= read());

/**
 * Records `marks` (project key → seq) where they are newer, or the first for a project. Without storage the marks
 * last until the window closes.
 */
export const markSeen = (marks: Readonly<Record<string, number>>): void => {
  const before = current();
  const changed = Object.entries(marks).filter(([k, seq]) => (before[k] ?? -1) < seq);
  if (changed.length === 0) return;
  seen = { ...before, ...Object.fromEntries(changed) };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(seen));
  } catch {
    // Kept in memory only.
  }
  for (const l of listeners) l();
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useSeen = (): Seen => useSyncExternalStore(subscribe, current);

/** The seq last seen in one project's chat, read once (the chat reads it as it opens, before it is marked seen). */
export const seenOf = (key: string): number | undefined => current()[key];
