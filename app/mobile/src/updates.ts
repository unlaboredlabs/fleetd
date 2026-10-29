// Update fleetd from the phone, for admins (Settings): the desktop app's Update button, its run and its words
// (app/desktop's screens/updates, flow.ts and model.ts). The hub updates itself, then every machine, and the phone
// follows the run live, machine by machine, to its outcome. The newest build is the one the hub has ready on its
// channel (hub_update_status `ready`), or the hub's own for a machine behind it. The phone updates over the air, so
// the desktop's "This app" part is left out. Members never see it; the hub refuses them all the same. Pure, so tested.
import { updatesView, type Flow, type HubState, type Line, type PartLine, type UpdateRun, type UpdatesState } from "./desktop";
import type { Machine } from "./store";

export interface UpdateSection {
  /** "Update fleetd": what it updates to, and what it does; null while a run goes on, or with nothing newer. */
  readonly offer: { readonly title: string; readonly note: string } | null;
  /** While a run goes on, or how the last one ended. */
  readonly progress: Line | null;
  /** The hub and each machine, while a run goes on or after one. */
  readonly parts: readonly PartLine[];
  readonly going: boolean;
  readonly startOver: { readonly note: string } | null;
}

export const UPDATE_NOTE = "Updates the hub and every machine; running work carries on after a restart.";

export interface UpdateInput {
  /** hub_info's `admin`; undefined until read. */
  readonly admin: boolean | undefined;
  readonly hub: HubState;
  readonly machines: readonly Machine[];
  readonly run: UpdateRun | null;
  readonly flow: Flow;
  readonly ready: string | null;
  readonly now?: number;
}

/** Null when there is nothing to show: not an admin, not connected, or the hub and its machines are up to date. */
export const updateSection = ({ admin, hub, machines, run, flow, ready, now = Date.now() }: UpdateInput): UpdateSection | null => {
  if (admin !== true || hub.phase !== "live") return null;
  // The model's "this app" stands in for the channel: the build the hub has ready, else the hub's own.
  const channel: UpdatesState = { current: hub.version ?? "", app: { kind: "unsupported" }, release: ready === null ? null : { cli: ready, app: null, changes: [] } };
  const view = updatesView({
    app: channel,
    hub: { url: hub.hub, version: hub.version },
    machines: machines.map((m) => ({ machineId: m.machineId, name: m.name, nodeVersion: m.nodeVersion, online: m.status !== "offline" })),
    run,
    flow,
    ready,
    now,
  });
  const offer = view.update === null ? null : { title: view.update.title, note: UPDATE_NOTE };
  if (offer === null && view.progress === null) return null;
  return { offer, progress: view.progress, parts: view.progress === null ? [] : view.lines.filter((l) => l.key !== "app"), going: view.going, startOver: view.startOver };
};
