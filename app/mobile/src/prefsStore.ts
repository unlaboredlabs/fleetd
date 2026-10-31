// This phone's chat prefs (prefs.ts) on disk, as one small JSON file in the app's documents, and the hook the screens
// read them with. Written after each change; a file that can't be read starts from nothing. The muted chats also go to
// the keychain for the Notification Service Extension (vault.ts saveMuted), which reads them once the
// notification-actions change lands; until then Mute only affects the count in the app.
import { File, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";
import type { PinStore } from "./pins";
import { noPrefs, parsePrefs, reducePrefs, type Prefs, type PrefsAction } from "./prefs";
import { saveMuted } from "./vault";

let prefs: Prefs = noPrefs;
const listeners = new Set<() => void>();
const file = (): File => new File(Paths.document, "chats.json");

const load = (): void => {
  try {
    const f = file();
    if (f.exists) prefs = parsePrefs(JSON.parse(f.textSync()) as unknown);
  } catch {
    prefs = noPrefs;
  }
};
load();

export const dispatchPrefs = (action: PrefsAction): void => {
  const next = reducePrefs(prefs, action);
  if (next === prefs) return;
  const muted = next.muted !== prefs.muted;
  prefs = next;
  for (const l of listeners) l();
  if (muted) void saveMuted(prefs.muted).catch(() => undefined);
  void file()
    .write(JSON.stringify(prefs))
    .catch(() => undefined);
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const usePrefs = (): Prefs => useSyncExternalStore(subscribe, () => prefs);

/** The session's copy of the pinned chats (pins.ts): the prefs' own, so the list follows it. */
export const pinStore: PinStore = {
  saved: () => prefs.pinned,
  save: (keys) => dispatchPrefs({ t: "pins", keys }),
};
