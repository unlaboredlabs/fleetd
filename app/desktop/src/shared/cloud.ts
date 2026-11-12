// fleetd cloud's Sign in, as the page sees it (main: src/main/cloud). Only a build given the cloud's accounts address
// and WorkOS client id offers it; any other build is the self-hosted app alone, with nothing of this on screen.
import type { AccountsInvite } from "./contracts";
import type { PairFailure } from "./pairing";

export interface CloudState {
  /** This build was given the cloud's two values: the first screen offers Sign in beside Use your own hub. */
  readonly available: boolean;
  /** Who is signed in, or null. The app keeps the email and WorkOS's session id, never a WorkOS token. */
  readonly email: string | null;
  /** The domain fleetd cloud's teams live under (`fleetd.dev`), from the build's accounts address; null without one. */
  readonly domain: string | null;
}

/** One team of the account's, and whether this app got its key. */
export type TeamOutcome = { readonly name: string; readonly ok: true } | { readonly name: string; readonly ok: false; readonly failure: PairFailure };

/** A pending invitation to a team, as the page asks about it: "<invitedBy> invited you to <name>". */
export interface Invitation {
  readonly name: string;
  readonly invitedBy: string;
  readonly role: string;
}

/**
 * A sign-in's answer, held in main until the person says it's them: who signed in, and each invitation to ask about,
 * by its place in this list. Nothing is connected yet.
 */
export interface Arrival {
  readonly email: string;
  readonly invitations: ReadonlyArray<Invitation>;
}

/** How the browser's part of a sign-in ended. Cancelled ends quietly: the person pressed Cancel, or started another. */
export type SignInOutcome =
  | { readonly ok: true; readonly arrival: Arrival }
  | { readonly ok: false; readonly cancelled: true }
  | { readonly ok: false; readonly cancelled?: undefined; readonly failure: PairFailure };

/** How a sign-in ended once the person said it's them: the account's teams and the invitations joined, each connected or not. */
export type FinishOutcome =
  | { readonly ok: true; readonly email: string; readonly teams: ReadonlyArray<TeamOutcome> }
  | { readonly ok: false; readonly failure: PairFailure };

/** Signed out. `kept` names each team whose hub couldn't be told to drop this device's key (it was offline). */
export interface SignOutOutcome {
  readonly kept: ReadonlyArray<string>;
}

/** Connect this computer: a terminal opened with the join line, or why not and the line to run. */
export type ConnectComputerOutcome = { readonly ok: true; readonly terminal: string } | { readonly ok: false; readonly message: string };

/** An invite by email, as Invite asks for one: the role is member or admin (owners are made from People, by an owner). */
export interface InviteRequest {
  readonly email: string;
  readonly role: "member" | "admin";
}

/** A team's open invites by email (only a hub that came with the account, asked by an owner's or admin's device). */
export type InvitesOutcome = { readonly ok: true; readonly invites: ReadonlyArray<AccountsInvite> } | { readonly ok: false; readonly failure: PairFailure };

/** An invite sent: fleetd cloud had WorkOS email the person. Or the team's refusal, in its words. */
export type InviteOutcome = { readonly ok: true; readonly invite: AccountsInvite } | { readonly ok: false; readonly failure: PairFailure };

/**
 * Install fleetd's GitHub App on a cloud team: GitHub's install page, as the team answered it, opened in the browser;
 * or why not. `connectFirst`: the person's own GitHub isn't connected yet, which the team needs before it hands out the
 * page.
 */
export type InstallGithubOutcome = { readonly ok: true } | { readonly ok: false; readonly connectFirst?: true; readonly failure: PairFailure };

/** An invite taken back, or why not. */
export type RevokeInviteOutcome = { readonly ok: true } | { readonly ok: false; readonly failure: PairFailure };
