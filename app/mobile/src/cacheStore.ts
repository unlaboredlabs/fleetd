// The hub's cache (cache.ts) on disk: one small JSON file in the app's caches, read once as the session starts and
// written a moment after what it keeps changes, at once when the app goes behind. A file that can't be read starts
// from nothing; Disconnect deletes it. Beside it, the pictures' previews the chats show, one small file each, so a
// chat opened again shows its pictures without reading them from the hub; iOS may clear them when space runs short.
import { Directory, File, Paths } from "expo-file-system";
import type { AttachmentGetOutput } from "./desktop";
import type { CacheStore, PreviewStore } from "./session";

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

const previews = (): Directory => new Directory(Paths.cache, "previews");

/** A hub's address as a short file-safe name: attachment ids are each hub's own. */
const hubName = (hub: string): string => {
  let h = 5381;
  for (let i = 0; i < hub.length; i++) h = ((h * 33) ^ hub.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

const previewFile = (hub: string, attachmentId: string): File => new File(previews(), `${hubName(hub)}-${attachmentId.replace(/[^A-Za-z0-9]/gu, "")}.json`);

export const diskPreviews: PreviewStore = {
  load: (hub, attachmentId) => {
    try {
      const f = previewFile(hub, attachmentId);
      return f.exists ? (JSON.parse(f.textSync()) as AttachmentGetOutput) : null;
    } catch {
      return null;
    }
  },
  save: (hub, attachmentId, preview) => {
    try {
      previews().create({ intermediates: true, idempotent: true });
      void previewFile(hub, attachmentId)
        .write(JSON.stringify(preview))
        .catch(() => undefined);
    } catch {
      // Not kept: it is read from the hub next time.
    }
  },
};

/** Deletes `hubs`' picture previews, and only theirs: the hub still shown keeps its own (fleetd cloud's sign-out). */
export const forgetPreviews = (hubs: readonly string[]): void => {
  if (hubs.length === 0) return;
  try {
    const d = previews();
    if (!d.exists) return;
    const prefixes = hubs.map((h) => `${hubName(h)}-`);
    for (const entry of d.list()) if (entry instanceof File && prefixes.some((p) => entry.name.startsWith(p))) entry.delete();
  } catch {
    // Left for iOS to clear when space runs short.
  }
};

export const forgetCache = (): void => {
  try {
    const f = file();
    if (f.exists) f.delete();
    const d = previews();
    if (d.exists) d.delete();
  } catch {
    // Nothing kept, or nothing to keep it from.
  }
};
