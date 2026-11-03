// The questions you hid from a chat's top bar (its ×): per chat, the lead message whose questions the bar stops
// saying, until the lead asks in a newer one. This app's own memory, not the hub's, so it lives in localStorage and
// lasts across restarts, as Activity's seen marks do (screens/activity/seen.ts).
import { useSyncExternalStore } from "react";

const KEY = "fleetd.hiddenWaits";

const read = (): Readonly<Record<string, string>> => {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
};

/** The marks when storage refused them; storage is read otherwise, so another window's count too. */
let held: Readonly<Record<string, string>> | undefined;
const listeners = new Set<() => void>();
const current = () => held ?? read();

/** Hides the questions of `message` in `chat` ("<machine>/<project>"). Without storage it lasts the window. */
export const hideWait = (chat: string, message: string): void => {
  const next = { ...current(), [chat]: message };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    held = next;
  }
  for (const l of listeners) l();
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The message whose questions `chat`'s bar no longer says, if any. */
export const useHiddenWait = (chat: string): string | undefined => useSyncExternalStore(subscribe, () => current()[chat]);
