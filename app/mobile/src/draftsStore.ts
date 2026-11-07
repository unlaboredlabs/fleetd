// The drafts (drafts.ts) on disk, as one small JSON file in the app's documents, as prefsStore.ts keeps the prefs, and
// the hook a chat's composer reads its own with. Written a moment after the typing stops, not with each letter; a file
// that can't be read starts from nothing.
import { File, Paths } from "expo-file-system";
import { useCallback, useSyncExternalStore } from "react";
import { emptyDraft, kept, parseDrafts, withDraft, type Draft, type Drafts } from "./drafts";
import type { Key } from "./store";

const WRITE_MS = 400;

let drafts: Drafts = {};
const listeners = new Set<() => void>();
const file = (): File => new File(Paths.document, "drafts.json");

try {
  const f = file();
  if (f.exists) drafts = parseDrafts(JSON.parse(f.textSync()) as unknown, Date.now());
} catch {
  drafts = {};
}

let timer: ReturnType<typeof setTimeout> | undefined;
const save = (): void => {
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void file()
      .write(JSON.stringify(kept(drafts)))
      .catch(() => undefined);
  }, WRITE_MS);
};

export const changeDraft = (key: Key, change: (d: Draft) => Draft): void => {
  const next = withDraft(drafts, key, change);
  if (next === drafts) return;
  drafts = next;
  for (const l of listeners) l();
  save();
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** A chat's draft now: the same object until that chat's own changes, so only its composer draws again. */
export const draftOf = (key: Key): Draft => drafts[key] ?? emptyDraft;

/** A chat's draft, and how to change it: the change goes to that chat's, wherever the person has gone since. */
export const useDraft = (key: Key): [Draft, (change: (d: Draft) => Draft) => void] => {
  const draft = useSyncExternalStore(subscribe, () => draftOf(key));
  const change = useCallback((c: (d: Draft) => Draft) => changeDraft(key, c), [key]);
  return [draft, change];
};
