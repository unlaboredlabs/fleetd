// Settings › Devices: the person's own devices on the hub shown, newest first, so a sign-in they didn't make (the "New
// sign-in" notification opens this list) is at the top, to sign out there. This phone is marked, and signs out with
// Disconnect instead.
import type { AgentKeyInfo } from "./desktop";

export interface DeviceRow {
  readonly keyId: string;
  readonly name: string;
  /** "Signed in 10:14 · last used Yesterday". */
  readonly detail: string;
  /** The key this app is calling with. */
  readonly here: boolean;
}

/**
 * The devices of the person `me` (people_list's), newest first: the hub lists them oldest first. `thisDevice` is the
 * caller's key, `when` the time as the lists say it.
 */
export const myDevices = (devices: readonly AgentKeyInfo[], me: string | undefined, thisDevice: string | undefined, when: (iso: string) => string): DeviceRow[] =>
  me === undefined
    ? []
    : devices
        .filter((d) => d.person?.personId === me && d.revokedAt === undefined)
        .reverse()
        .map((d) => ({
          keyId: d.keyId,
          name: d.name,
          detail: d.lastUsedAt === undefined ? `Signed in ${when(d.createdAt)}` : `Signed in ${when(d.createdAt)} · last used ${when(d.lastUsedAt)}`,
          here: d.keyId === thisDevice,
        }));

/** The sign-out's confirm. */
export const signOutWords = (name: string, hubName: string): { title: string; message: string } => ({
  title: `Sign Out ${name}?`,
  message: `It stops working on ${hubName} at once. To use it again, sign in or pair it again.`,
});

/** Whether a notification's hub (the payload's `hub`) is the hub shown: the same address, a trailing slash aside. */
export const sameHub = (a: string, b: string): boolean => a.replace(/\/+$/u, "") === b.replace(/\/+$/u, "");
