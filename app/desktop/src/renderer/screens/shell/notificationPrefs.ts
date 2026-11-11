// Settings → General → Notifications: which kinds alert. Per install, in the renderer's storage like the theme; the
// shell reads them when it posts. A sound and the Dock badge are the system's own per-app switches.
import { useSyncExternalStore } from "react";
import type { NotifyKind } from "./notifier";

export interface NotificationPrefs {
  readonly kinds: Readonly<Record<NotifyKind, boolean>>;
}

export const DEFAULT_PREFS: NotificationPrefs = {
  kinds: { reply: true, approval: true, done: true, machine: true, other: true },
};

const KEY = "fleetd.notifications";

const flag = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

/** Whatever was stored, with anything missing or off-shape at its default; an older app's `sound` and `badge` are dropped. */
export const parsePrefs = (raw: string | null): NotificationPrefs => {
  let stored: unknown;
  try {
    stored = raw === null ? null : JSON.parse(raw);
  } catch {
    stored = null;
  }
  const o = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const kinds = typeof o["kinds"] === "object" && o["kinds"] !== null ? (o["kinds"] as Record<string, unknown>) : {};
  const d = DEFAULT_PREFS;
  return {
    kinds: {
      reply: flag(kinds["reply"], d.kinds.reply),
      approval: flag(kinds["approval"], d.kinds.approval),
      done: flag(kinds["done"], d.kinds.done),
      machine: flag(kinds["machine"], d.kinds.machine),
      other: flag(kinds["other"], d.kinds.other),
    },
  };
};

const read = (): string | null => {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

let prefs: NotificationPrefs = parsePrefs(read());
const listeners = new Set<() => void>();

export const notificationPrefs = (): NotificationPrefs => prefs;

export function setNotificationPrefs(next: NotificationPrefs) {
  prefs = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable (a locked profile); the choice still holds for this run.
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useNotificationPrefs = (): NotificationPrefs => useSyncExternalStore(subscribe, notificationPrefs);
