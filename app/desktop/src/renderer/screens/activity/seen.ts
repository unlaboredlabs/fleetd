// What the person last saw in each project's Activity: the newest event seq the feed showed. The feed's "since you
// last looked" divider sits under what is newer, and the unread count counts it. This app's own memory, not the
// hub's, so it lives in localStorage as the chat's (src/data/seen.ts) does.
import { useSyncExternalStore } from "react";

const KEY = "fleetd.seenActivity";

const read = (): Readonly<Record<string, number>> => {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number"));
  } catch {
    return {};
  }
};

/** The marks when storage refused them; storage is read otherwise, so another window's marks count too. */
let held: Readonly<Record<string, number>> | undefined;
const listeners = new Set<() => void>();
const current = () => held ?? read();

/** Records `seq` as seen in `project` ("<machine>/<project>") when it is newer. Without storage it lasts the window. */
export const markActivitySeen = (project: string, seq: number): void => {
  const before = current();
  if ((before[project] ?? -1) >= seq) return;
  const next = { ...before, [project]: seq };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    held = next;
  }
  for (const l of listeners) l();
};

/** The seq last seen in `project`'s Activity, read once (the feed reads it as it opens, before marking). */
export const activitySeenOf = (project: string): number | undefined => current()[project];

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useActivitySeen = (project: string): number | undefined => useSyncExternalStore(subscribe, () => current()[project]);
