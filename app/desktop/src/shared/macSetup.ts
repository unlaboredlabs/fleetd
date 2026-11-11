// "Set up this Mac for agents" (D309): the fleetd app on a Mac makes that Mac the hub's agents' Mac, from a 6-digit
// code Add machine › A Mac for agents shows on the person's main machine. Main finds the hub, trades the code at
// POST /pair/mac for a one-time enroll token (which never reaches the page), installs the hub's own fleetd and runs
// the CLI's join; the page then watches the node's checks (mac-health.json) until every one is green.
import type { MacHealth } from "./contracts";
import type { JoinStep, ThisComputer } from "./joinHere";
import type { MacBehind } from "./macMenuBar";

/** A failure in words: what went wrong, what to do, and which field it is about. */
export interface MacSetupFailure {
  readonly message: string;
  readonly fix?: string;
  /** The field the person changes: the code, or the hub's address. */
  readonly field?: "code" | "hub";
  /** The address it was about, to show in the hub field. */
  readonly hub?: string;
  /** The hubs this Mac found when there was more than one: the person picks theirs, and only it gets the code. */
  readonly choices?: ReadonlyArray<string>;
  /** This app is older than the hub, and its own update is the fix: the page offers Update. */
  readonly updateApp?: boolean;
}

/** What the page sends to trade a code: `hub` only when the person typed an address. */
export interface MacRedeemRequest {
  readonly code: string;
  readonly hub?: string | undefined;
}

/** The hub took the code: where it is, which machine this Mac joins as, and what this Mac holds now. */
export interface MacFound {
  readonly hubUrl: string;
  readonly hubName: string;
  readonly machineId: string;
  /** The hub has this machine already: joining replaces it in place (`--rejoin`). */
  readonly existing: boolean;
  /** This Mac's fleetd dir: a node already enrolled here is replaced. */
  readonly here: ThisComputer;
}

export type MacRedeemOutcome = { readonly ok: true; readonly found: MacFound } | { readonly ok: false; readonly failure: MacSetupFailure };

export interface MacJoin {
  readonly state: "running" | "done" | "failed";
  readonly steps: ReadonlyArray<JoinStep>;
  readonly failure?: MacSetupFailure;
  /** Failed before the token was spent: the same code tries again. */
  readonly retry?: boolean;
}

/** The node's checks as it last wrote them, and whether the hub answers this Mac. */
export interface MacHealthRead {
  readonly health: MacHealth | null;
  /** When the node last wrote them (ms since the epoch), a full run or a fresh read of the grants; null when there is no file. */
  readonly writtenAt: number | null;
  /** When the node last ran every check (`mac-health.checked`); null before its first. */
  readonly checkedAt: number | null;
  readonly now: number;
  /** The hub answered its /healthz from this Mac just now. */
  readonly hubAnswers: boolean;
  /** The hub runs an older fleetd than this Mac's node; null when it doesn't, or either can't say. */
  readonly hubBehind: HubBehind | null;
  /** This Mac's node runs an older fleetd than the hub: the menu bar offers the hub's Update. Absent from older apps' reads. */
  readonly macBehind?: MacBehind | null;
}

/**
 * The hub runs an older fleetd than this Mac's node: the edge release had moved on past the hub's build when this Mac
 * joined, so it got the newer one. Both work together; the hub's Update brings it level. `who`: this app is signed in
 * to the hub as an admin, who updates it from here; as a member, who asks an admin; or not at all, told where.
 */
export interface HubBehind {
  readonly hubVersion: string;
  readonly macVersion: string;
  readonly who: "admin" | "member" | "unknown";
}

/** Where an admin updates the hub, for when this app can't do it from the Mac. */
export const HUB_UPDATE_WHERE = "On your main machine, open Settings › Hub › Machines › Updates and press Update.";

export type MacHubUpdateOutcome = { readonly ok: true } | { readonly ok: false; readonly failure: MacSetupFailure };

/** What setup opens on the Mac: a System Settings pane, or Xcode's page in the App Store. */
export const MAC_PANES = ["accessibility", "screen_recording", "app_store"] as const;
export type MacPane = (typeof MAC_PANES)[number];

export type MacRestartOutcome = { readonly ok: true } | { readonly ok: false; readonly failure: MacSetupFailure };

/**
 * What main knows of this Mac's setup as the window opens, so a window closed partway opens on what happened: nothing
 * yet; a code the hub took for a join not run yet; a join running; a node joined as the agents' Mac (from node.json);
 * or a code spent with nothing joined (cancelled, its token expired, or the join failed), with what to do.
 */
export type MacSetupStatus =
  | { readonly kind: "fresh" }
  | { readonly kind: "traded"; readonly found: MacFound }
  | { readonly kind: "joining"; readonly found: MacFound }
  | { readonly kind: "joined"; readonly found: MacFound }
  | { readonly kind: "spent"; readonly failure: MacSetupFailure };
