// Each team's offline cache in this browser: the text the renderer keeps (renderer/src/data/cache.ts, the desktop's
// own: the bot list, the recent chats, messages waiting to go; never a secret or a vault value), so a page opened
// again shows the bot list at once, marked offline as of when it was current, while the team's socket connects.
// One account's only: kept under the email signed in, and gone at sign-out, when the page finds itself signed out,
// and when another account signs in here.
const INDEX_KEY = "fleetd.web.cache";
const itemKey = (teamId: string) => `${INDEX_KEY}.${teamId}`;

export type CacheStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface Index {
  readonly owner: string;
  readonly teams: readonly string[];
}

const readIndex = (storage: CacheStorage): Index | null => {
  try {
    const raw: unknown = JSON.parse(storage.getItem(INDEX_KEY) ?? "null");
    if (raw === null || typeof raw !== "object") return null;
    const { owner, teams } = raw as { owner?: unknown; teams?: unknown };
    if (typeof owner !== "string" || !Array.isArray(teams)) return null;
    return { owner, teams: teams.filter((t): t is string => typeof t === "string") };
  } catch {
    return null;
  }
};

const drop = (storage: CacheStorage, teams: readonly string[]) => {
  for (const team of teams) storage.removeItem(itemKey(team));
};

/** Every team's cache in this browser, whoever it was kept for. */
export const clearWebCache = (storage: CacheStorage): void => {
  drop(storage, readIndex(storage)?.teams ?? []);
  storage.removeItem(INDEX_KEY);
};

export interface WebCache {
  read(teamId: string): string | null;
  write(teamId: string, text: string): void;
  /** Clears it, and keeps it clear for the rest of this page: a write on the way out (pagehide) is dropped. */
  clear(): void;
}

/** The cache of `email`'s `teams`: another account's, and a team the account has left, are dropped first. */
export const webCache = (storage: CacheStorage, email: string, teams: readonly string[]): WebCache => {
  const found = readIndex(storage);
  let kept: readonly string[] = [];
  if (found !== null && found.owner === email) {
    kept = found.teams.filter((t) => teams.includes(t));
    drop(storage, found.teams.filter((t) => !teams.includes(t)));
  } else if (found !== null) {
    drop(storage, found.teams);
  }
  const save = () => storage.setItem(INDEX_KEY, JSON.stringify({ owner: email, teams: kept }));
  save();
  let cleared = false;
  return {
    read: (teamId) => (cleared || !kept.includes(teamId) ? null : storage.getItem(itemKey(teamId))),
    write: (teamId, text) => {
      if (cleared || !teams.includes(teamId)) return;
      try {
        storage.setItem(itemKey(teamId), text);
      } catch {
        // Over the browser's quota: no cache rather than a cut one.
        storage.removeItem(itemKey(teamId));
        return;
      }
      if (!kept.includes(teamId)) {
        kept = [...kept, teamId];
        save();
      }
    },
    clear: () => {
      cleared = true;
      clearWebCache(storage);
    },
  };
};
