// This phone's chat prefs (prefs.ts) on disk, as one small JSON file in the app's documents, and the hook the screens
// read them with. Written after each change; a file that can't be read starts from nothing. The muted chats also go to
// the keychain, where the Notification Service Extension reads them (vault.ts saveMuted).
import { File, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";
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
