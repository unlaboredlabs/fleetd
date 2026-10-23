// When the app makes itself the OS handler for fleetd:// links. Not on every launch: that would take the scheme back
// from whatever the user chose. It claims once on first run, and when a pairing link failed because another app (an older install) took the scheme. A dev build never claims: the handler would
// be the bare Electron binary. Pure, so it is unit-tested; linkHandlerMain.ts does the I/O.

export type ClaimReason = "first-run" | "pair-failed";

export interface ClaimInputs {
  readonly packaged: boolean;
  readonly reason: ClaimReason;
  /** A first-run claim was already made (recorded in userData). */
  readonly claimedBefore: boolean;
  /** This app is the handler now. */
  readonly isHandler: boolean;
}

export const shouldClaim = (i: ClaimInputs): boolean => {
  if (!i.packaged) return false;
  switch (i.reason) {
    case "first-run":
      return !i.claimedBefore;
    case "pair-failed":
      return !i.isHandler;
  }
};
