// This phone's chat prefs (prefs.ts) on disk, as one small JSON file in the app's documents, and the hook the screens
// read them with. Written after each change; a file that can't be read starts from nothing. The muted chats also go to
// the keychain for the Notification Service Extension (vault.ts saveMuted), which reads them once the
// notification-actions change lands; until then Mute only affects the count in the app.
import { File, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";
import type { PinStore } from "./pins";
import type { SectionStore } from "./sections";
import { hubPinStore, hubSectionStore, noPrefs, parsePrefs, reducePrefs, type HubOrigin, type Prefs, type PrefsAction } from "./prefs";
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

/** Each change of the prefs, with them before and after: notifications.ts clears a chat read here. */
export const onPrefs = (listener: (now: Prefs, was: Prefs) => void): (() => void) => {
  let was = prefs;
  return subscribe(() => {
    const now = prefs;
    listener(now, was);
    was = now;
  });
};

/** A hub's session's copy of its pinned chats (pins.ts): the prefs' own, so the list follows it. */
export const pinStoreFor = (hub: HubOrigin): PinStore => hubPinStore(() => prefs, dispatchPrefs, hub);

/** A hub's session's copy of the person's sections (sections.ts): the prefs' own, so the list follows it. */
export const sectionStoreFor = (hub: HubOrigin): SectionStore => hubSectionStore(() => prefs, dispatchPrefs, hub);
