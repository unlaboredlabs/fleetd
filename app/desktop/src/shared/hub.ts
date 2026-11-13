// The hub data the renderer sees: the /app protocol's own shapes, generated from crates/fleetd-contracts.
import type { BrowserFrame, ChatDelta, FleetStatus, HubEvent, HubInfoOutput, LiveFrame, ScreenThumb } from "./contracts";

export type { BrowserFrame, HubEvent, LiveFrame };
/** The answer to `snapshot`: fleetd_status's data, with the event cursor to resume from. */
export type Snapshot = FleetStatus;

/**
 * After a wake (HubState's `waking`), main redials fast for this long, and the screens hold what they showed without an
 * offline word: a tailnet needs a moment to come back, and a reconnect then is about to succeed.
 */
export const WAKE_QUIET_MS = 10_000;

/** The connection as the UI should present it. The key itself never leaves main. */
export type HubState =
  | { readonly phase: "unpaired"; readonly note?: string | undefined }
  /**
   * `restarting`: when the hub closed the link to restart or stop (close 1001 or 1012), epoch ms; `updatingTo`: the
   * build it restarts into when the close said it updates ("updating to <version>"). Both stay until a link is ready
   * again; absent for any other drop and at launch. `waking`: when the computer woke, its screen unlocked or the
   * network came back and the link that had been live was dialled again, epoch ms, until a link is ready again: the
   * screens keep what they show and say nothing for WAKE_QUIET_MS.
   */
  | {
      readonly phase: "connecting";
      readonly hub: string;
      readonly attempt: number;
      readonly restarting?: number | undefined;
      readonly updatingTo?: string | undefined;
      readonly waking?: number | undefined;
    }
  /**
   * `version`: the hub's fleetd version from its ready frame, absent from hubs before it; `features`: what newer the
   * hub serves, from the same frame (`browser_sessions`: the Agents section's Sessions). Both fresh on each connection.
   */
  | { readonly phase: "live"; readonly hub: string; readonly protocol: number; readonly version?: string | undefined; readonly features?: readonly string[] | undefined }
  /** `reason`: what went wrong, one sentence without a final period; `fix`: what to do about it. `retryAt` is epoch ms. */
  | {
      readonly phase: "retrying";
      readonly hub: string;
      readonly reason: string;
      readonly fix?: string | undefined;
      readonly retryAt: number;
      readonly restarting?: number | undefined;
      readonly updatingTo?: string | undefined;
      readonly waking?: number | undefined;
    }
  /** The hub refused the key (close 4401 or an auth error). Nothing retries until a new key is saved. */
  | { readonly phase: "refused"; readonly hub: string; readonly message: string };

export interface HubError {
  /** A hub ErrorCode (`invalid`, `forbidden`, `not_found`, …) or one of the shell's own: `timeout`, `offline`, `disconnected`. */
  readonly code: string;
  readonly message: string;
  readonly fix?: string | undefined;
  /** Which refusal it is, for an app that acts on one (`no_project`); absent from most errors and older hubs. */
  readonly reason?: string | undefined;
}

export type CallOutcome = { readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: HubError };
export type OpenOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };
/** A file saved to the Downloads folder: where it is, and the name it got (a number added when its own was taken). */
export type DownloadOutcome = { readonly ok: true; readonly path: string; readonly name: string } | { readonly ok: false; readonly message: string };
export type ConnectOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** main → renderer, on IPC.hubFrame. After a `state` with phase `live`, a `snapshot` always precedes events. */
export type HubFrame =
  | { readonly t: "state"; readonly state: HubState }
  /**
   * `resumed`: a reconnect's, with the events the old link missed after it, from the last one this window applied:
   * what the window read stays, and those events make stale what they touch.
   */
  | { readonly t: "snapshot"; readonly snapshot: Snapshot; readonly resumed?: true }
  | { readonly t: "event"; readonly event: HubEvent }
  | { readonly t: "live"; readonly frame: LiveFrame }
  /** Streamed text of the subscribed chat's lead message (see hub.chat). */
  | { readonly t: "chat_delta"; readonly delta: ChatDelta }
  /** The watched browser session's newest page (see hub.watch); never kept, only shown. */
  | { readonly t: "browser_frame"; readonly frame: BrowserFrame }
  /** A live screen's picture for the Screens page (see hub.thumbs); never kept on disk. */
  | { readonly t: "screen_thumb"; readonly thumb: ScreenThumb }
  /** A session-level hub error (not an answer to a call). */
  | { readonly t: "error"; readonly error: HubError };

/** A secret ask's submit: the node's fingerprint of what it stored (8 hex characters), never the value. */
export type SecretOutcome = { readonly ok: true; readonly fingerprint: string } | { readonly ok: false; readonly error: HubError };
/**
 * What a folder or file dropped on the window holds for Add project: a folder (whether it is a git checkout, and its
 * GitHub origin as "owner/name"), a link file's GitHub repository, or nothing usable. Never file contents.
 */
export type DropInfo =
  | { readonly kind: "folder"; readonly path: string; readonly git: boolean; readonly repo?: string }
  | { readonly kind: "link"; readonly repo: string }
  | { readonly kind: "other" };

/**
 * Whether this app's person administers the hub: an owner or admin whose device isn't capped below admin. A hub from
 * before people names no person; there it is the key's own admin grant, as Settings asked before: a hub too old to
 * say leaves the app to try, and refuses a change it doesn't allow. False until hub_info answers.
 */
export function administers(info: Pick<HubInfoOutput, "admin" | "me"> | undefined): boolean {
  if (info === undefined) return false;
  if (info.me === undefined) return info.admin !== false;
  return (info.me.role === "owner" || info.me.role === "admin") && info.admin !== false;
}

/**
 * Whether the hub serves a tool: every one but those its hub_info leaves out (fleetd cloud's self-update, restart,
 * doctor, setup and SSH machine add), whose controls the apps hide there. Yes before hub_info answers, and from a hub
 * that leaves nothing out, as every self-run one does.
 */
export const serves = (info: { readonly leftOut?: readonly string[] | undefined } | undefined, tool: string): boolean => info?.leftOut?.includes(tool) !== true;
