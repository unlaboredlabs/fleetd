// The hub data the renderer sees. Snapshot, HubEvent and LiveFrame are the /app protocol's own shapes
// (crates/fleetd-contracts/src/app.rs); until the generated contract types land they are typed by the fields the
// shell itself relies on.

export type Snapshot = { readonly cursor: number } & Readonly<Record<string, unknown>>;
export type HubEvent = { readonly seq: number; readonly type: string } & Readonly<Record<string, unknown>>;
export type LiveFrame = { readonly full: boolean } & Readonly<Record<string, unknown>>;

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
