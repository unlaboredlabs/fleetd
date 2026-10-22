// The hub's version and its update (C2: FleetStatus.hub, the `hub.update` event, the hub_update tool), as the
// contract names them. Declared here until crates/fleetd-contracts generates them; then this file re-exports those.
import type { Call } from "../../../shared/contracts";
import type { HubError, HubEvent, Snapshot } from "../../../shared/hub";

export type ReleaseChannel = "nightly" | "stable";
export type HubUpdateState = "waiting" | "installing" | "restarting" | "done" | "failed";
export type HubUpdateWhen = "idle" | "now" | "cancel";

export interface HubUpdateProgress {
  readonly state: HubUpdateState;
  /** The version it updates to. */
  readonly to: string;
  /** A plain line, the event's summary too. */
  readonly text: string;
  readonly at: string;
}

export interface HubVersion {
  /** The running hub; its CLI and node ship in the same binary. */
  readonly version: string;
  readonly channel: ReleaseChannel;
  /** The newest build on the channel; absent before the first check, on a local build, or with none on the channel. */
  readonly latest?: string;
  readonly updateAvailable: boolean;
  /** What's new between version and latest, newest first, plain lines (at most 10). */
  readonly notes: readonly string[];
  readonly checkedAt?: string;
  readonly update?: HubUpdateProgress;
}

export interface HubUpdateOutput {
  readonly hub: HubVersion;
  /** What a restart now would stop, in plain lines; empty when nothing runs. */
  readonly running: readonly string[];
}

export const HUB_UPDATE_EVENT = "hub.update";
export const HUB_UPDATE_TOOL = "hub_update";

/** The snapshot's `hub`, absent from hubs before it. */
export const snapshotHub = (snapshot: Snapshot): HubVersion | undefined => (snapshot as Snapshot & { hub?: HubVersion }).hub;

/** A `hub.update` event's HubVersion, or undefined (another type, or data the hub cut for size). */
export const eventHub = (event: HubEvent): HubVersion | undefined => {
  if (event.type !== HUB_UPDATE_EVENT) return undefined;
  const data: unknown = event.data;
  return typeof data === "object" && data !== null && typeof (data as { version?: unknown }).version === "string" ? (data as HubVersion) : undefined;
};

export type HubUpdateOutcome = { readonly ok: true; readonly output: HubUpdateOutput } | { readonly ok: false; readonly error: HubError };

/** hub_update through the data layer's call, which folds its answer into the store. Human keys only. */
export const hubUpdate = (call: Call, when: HubUpdateWhen): Promise<HubUpdateOutcome> =>
  (call as unknown as (tool: string, input: unknown) => Promise<HubUpdateOutcome>)(HUB_UPDATE_TOOL, { when });
