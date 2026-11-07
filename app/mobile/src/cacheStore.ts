// The hub's cache (cache.ts) on disk: one small JSON file in the app's caches, read once as the session starts and
// written a moment after what it keeps changes, at once when the app goes behind. A file that can't be read starts
// from nothing; Disconnect deletes it.
import { File, Paths } from "expo-file-system";
import type { CacheStore } from "./session";

const file = (): File => new File(Paths.cache, "hub.json");

export const diskCache: CacheStore = {
  load: () => {
    try {
      const f = file();
      return f.exists ? (JSON.parse(f.textSync()) as unknown) : null;
    } catch {
      return null;
    }
  },
  save: (cached) => {
    void file()
      .write(JSON.stringify(cached))
      .catch(() => undefined);
  },
};

export const forgetCache = (): void => {
  try {
    const f = file();
    if (f.exists) f.delete();
  } catch {
    // Nothing kept, or nothing to keep it from.
  }
};
