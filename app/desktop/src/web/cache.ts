// Each team's offline cache in this browser: the text the renderer keeps (renderer/src/data/cache.ts, the desktop's
// own: the bot list, the recent chats, messages waiting to go; never a secret or a vault value), so a page opened
// again shows the bot list at once, marked offline as of when it was current, while the team's socket connects.
// One account's only: kept under the email signed in, and gone at sign-out, when the page finds itself signed out,
// and when another account signs in here. Several tabs share it, so each read and write first checks that the index
// still names this page's account: a tab whose account was signed out in another, or replaced by another account,
// keeps nothing from then on.
const PREFIX = "fleetd.web.cache";
const INDEX_KEY = PREFIX;
const itemKey = (teamId: string) => `${PREFIX}.${teamId}`;

export type CacheStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

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

/** Every team's cache in this browser, whoever it was kept for: each key of the cache's, listed or not. */
export const clearWebCache = (storage: CacheStorage): void => {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && (key === INDEX_KEY || key.startsWith(`${PREFIX}.`))) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
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
  if (found === null || found.owner !== email) clearWebCache(storage);
  else for (const team of found.teams.filter((t) => !teams.includes(t))) storage.removeItem(itemKey(team));
  const kept = (found?.owner === email ? found.teams : []).filter((t) => teams.includes(t));
  let cleared = false;
  try {
    storage.setItem(INDEX_KEY, JSON.stringify({ owner: email, teams: kept }));
  } catch {
    // The browser's storage is full: this page keeps no cache, and the page itself goes on.
    clearWebCache(storage);
    cleared = true;
  }
  /** This page's account still owns the cache; once it doesn't (signed out, or another account here), never again. */
  const own = (): Index | null => {
    const index = cleared ? null : readIndex(storage);
    if (index?.owner === email) return index;
    cleared = true;
    return null;
  };
  return {
    read: (teamId) => (own()?.teams.includes(teamId) === true ? storage.getItem(itemKey(teamId)) : null),
    write: (teamId, text) => {
      const index = own();
      if (index === null || !teams.includes(teamId)) return;
      try {
        if (!index.teams.includes(teamId)) storage.setItem(INDEX_KEY, JSON.stringify({ owner: email, teams: [...index.teams, teamId] }));
        storage.setItem(itemKey(teamId), text);
      } catch {
        // Over the browser's quota: no cache for this team rather than a cut one, and nothing thrown.
        storage.removeItem(itemKey(teamId));
      }
    },
    clear: () => {
      cleared = true;
      clearWebCache(storage);
    },
  };
};
