// The hub data the renderer sees: the /app protocol's own shapes, generated from crates/fleetd-contracts.
import type { FleetStatus, HubEvent, LiveFrame } from "./contracts";

export type { HubEvent, LiveFrame };
/** The answer to `snapshot`: fleetd_status's data, with the event cursor to resume from. */
export type Snapshot = FleetStatus;

/** The connection as the UI should present it. The key itself never leaves main. */
export type HubState =
  | { readonly phase: "unpaired"; readonly note?: string | undefined }
  | { readonly phase: "connecting"; readonly hub: string; readonly attempt: number }
  | { readonly phase: "live"; readonly hub: string; readonly protocol: number }
  /** `retryAt` is epoch ms. */
  | { readonly phase: "retrying"; readonly hub: string; readonly reason: string; readonly retryAt: number }
  /** The hub refused the key (close 4401 or an auth error). Nothing retries until a new key is saved. */
  | { readonly phase: "refused"; readonly hub: string; readonly message: string };

export interface HubError {
  /** A hub ErrorCode (`invalid`, `forbidden`, `not_found`, …) or one of the shell's own: `timeout`, `offline`, `disconnected`. */
  readonly code: string;
  readonly message: string;
  readonly fix?: string | undefined;
}

export type CallOutcome = { readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: HubError };
export type OpenOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };
export type ConnectOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** main → renderer, on IPC.hubFrame. After a `state` with phase `live`, a `snapshot` always precedes events. */
export type HubFrame =
  | { readonly t: "state"; readonly state: HubState }
  | { readonly t: "snapshot"; readonly snapshot: Snapshot }
  | { readonly t: "event"; readonly event: HubEvent }
  | { readonly t: "live"; readonly frame: LiveFrame }
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
