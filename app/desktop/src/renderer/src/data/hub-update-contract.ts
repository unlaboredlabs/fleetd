// The hub's own update, as the app reads and starts it. The one place that knows which contract each part comes from:
// - main's (#275): the hub's version in the ready frame (HubState's `version`), and hub_info's `busy`, what a restart
//   would stop;
// - C2's, still on its branch: hub_update, which updates the hub once nothing runs (or now), and its `hub.update`
//   event. Declared here until crates/fleetd-contracts generates them; then this file re-exports those.
// Screens use only what this file exports, so C2's final shape changes this file alone.
import type { Call } from "../../../shared/contracts";
import type { HubError, HubEvent, HubState } from "../../../shared/hub";

export type HubUpdateState = "waiting" | "installing" | "restarting" | "done" | "failed";
export type HubUpdateWhen = "idle" | "now" | "cancel";

/** An update of the hub under way, or how the last one ended. */
export interface HubUpdateProgress {
  readonly state: HubUpdateState;
  /** The version it updates to. */
  readonly to: string;
  /** A plain line, worded by the hub. */
  readonly text: string;
  readonly at: string;
}

/** C2's hub_update answer, as its branch declares it: the hub's version with the update's progress. */
interface PendingHubUpdateOutput {
  readonly hub?: { readonly update?: HubUpdateProgress };
}

export const HUB_UPDATE_EVENT = "hub.update";
export const HUB_UPDATE_TOOL = "hub_update";

/** The connected hub's fleetd version, from its ready frame; undefined while not connected or from a hub before it. */
export const hubVersionOf = (state: HubState): string | undefined => (state.phase === "live" ? state.version : undefined);

/**
 * Whether this hub can update itself (hub_update). C2's hub reports its version in the ready frame and has hub_update;
 * a hub that doesn't report it gets the command to run instead.
 */
export const updatesItself = (state: HubState): boolean => hubVersionOf(state) !== undefined;

const progressOf = (data: unknown): HubUpdateProgress | undefined => {
  if (typeof data !== "object" || data === null) return undefined;
  const update = (data as PendingHubUpdateOutput).hub?.update ?? (data as { update?: unknown }).update;
  return typeof update === "object" && update !== null && typeof (update as { state?: unknown }).state === "string" ? (update as HubUpdateProgress) : undefined;
};

/** A `hub.update` event's progress, or undefined (another type, or data the hub cut for size). */
export const eventProgress = (event: HubEvent): HubUpdateProgress | undefined => (event.type === HUB_UPDATE_EVENT ? progressOf(event.data) : undefined);

/** hub_update's answer's progress, for the data layer to show before its event. */
export const answerProgress = (output: unknown): HubUpdateProgress | undefined => progressOf(output);

export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: HubError };

/** hub_update through the data layer's call, which shows its answer at once. Human keys only. */
export const hubUpdate = async (call: Call, when: HubUpdateWhen): Promise<Outcome<null>> => {
  const outcome = await (call as unknown as (tool: string, input: unknown) => Promise<{ ok: true; output: unknown } | { ok: false; error: HubError }>)(
    HUB_UPDATE_TOOL,
    { when },
  );
  return outcome.ok ? { ok: true, value: null } : outcome;
};

/** What restarting the hub now would stop, one plain line each (hub_info's `busy`); empty when nothing runs. */
export const restartStops = async (call: Call): Promise<Outcome<readonly string[]>> => {
  const outcome = await call("hub_info", {});
  return outcome.ok ? { ok: true, value: outcome.output.busy.map((item) => item.text) } : outcome;
};
