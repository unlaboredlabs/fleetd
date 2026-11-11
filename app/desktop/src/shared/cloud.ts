// fleetd cloud's Sign in, as the page sees it (main: src/main/cloud). Only a build given the cloud's accounts address
// and WorkOS client id offers it; any other build is the self-hosted app alone, with nothing of this on screen.
import type { PairFailure } from "./pairing";

export interface CloudState {
  /** This build was given the cloud's two values: the first screen offers Sign in beside Use your own hub. */
  readonly available: boolean;
  /** Who is signed in, or null. The app keeps the email and WorkOS's session id, never a WorkOS token. */
  readonly email: string | null;
}

/** One team of the account's, and whether this app got its key. */
export type TeamOutcome = { readonly name: string; readonly ok: true } | { readonly name: string; readonly ok: false; readonly failure: PairFailure };

/** How a sign-in ended. Cancelled ends quietly: the person pressed Cancel, or started another. */
export type SignInOutcome =
  | { readonly ok: true; readonly email: string; readonly teams: ReadonlyArray<TeamOutcome> }
  | { readonly ok: false; readonly cancelled: true }
  | { readonly ok: false; readonly cancelled?: undefined; readonly failure: PairFailure };

/** Signed out. `kept` names each team whose hub couldn't be told to drop this device's key (it was offline). */
export interface SignOutOutcome {
  readonly kept: ReadonlyArray<string>;
}

/** Connect this computer: a terminal opened with the join line, or why not and the line to run. */
export type ConnectComputerOutcome = { readonly ok: true; readonly terminal: string } | { readonly ok: false; readonly message: string };
