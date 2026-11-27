// A session that ended while the app was open (it expired, or was signed out elsewhere): the page starts again on the
// gate, which says so and signs back in as the same account, rather than dropping the person on the sign-in provider's
// page with no word why and an empty email box. Kept in this browser until the next sign-in starts the app.
import type { CacheStorage } from "./cache";

const KEY = "fleetd.web.ended";

/** Marks the session `email` had as ended, for the gate the page starts again on. */
export const markEnded = (storage: CacheStorage, email: string): void => {
  try {
    storage.setItem(KEY, email);
  } catch {
    // No room: the gate says only Sign in, as for a first visit.
  }
};

/** The account whose session ended here, until a sign-in starts the app again; undefined otherwise. */
export const endedEmail = (storage: CacheStorage): string | undefined => {
  try {
    return storage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

export const clearEnded = (storage: CacheStorage): void => {
  try {
    storage.removeItem(KEY);
  } catch {
    // Nothing kept.
  }
};
