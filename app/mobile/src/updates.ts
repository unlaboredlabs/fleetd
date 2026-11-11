// Update fleetd from the phone (Settings › Update): the one status the desktop app shows (app/desktop's
// screens/updates model.ts), in the same words. A title, one quiet line, one button, and a machine only when it
// didn't update or is behind. An admin reads it and presses its button; a member reads only how the hub's last update
// ended, as the hub told everyone. The phone updates over the air, so the desktop's "this app" is left out. Pure, so
// tested.
import { updateStatus, versionLabel, type Auto, type Flow, type HubState, type HubUpdateData, type Status, type UpdateRun } from "./desktop";
import { FAILED_FOR_MS, UPDATED_FOR_MS } from "./hubWord";
import type { Machine, Restart } from "./store";

export interface UpdateInput {
  /** hub_info's `admin`; undefined until read. */
  readonly admin: boolean | undefined;
  readonly hub: HubState;
  readonly machines: readonly Machine[];
  readonly run: UpdateRun | null;
  readonly flow: Flow;
  readonly ready: string | null;
  readonly auto: Auto | null;
  /** The hub's last restart as this phone saw it (store.ts). */
  readonly restart: Restart | null;
  /** The hub's update as it tells everyone (`hub.update`). */
  readonly update: HubUpdateData | undefined;
  readonly now?: number;
}

/** When the hub last came back on a new build, or its update ended well, while that is news; else undefined. */
const updatedAt = (restart: Restart | null, update: HubUpdateData | undefined, now: number): number | undefined => {
  if (restart?.t === "updated" && now - restart.at < UPDATED_FOR_MS) return restart.at;
  const ended = update?.state === "updated" && update.finishedAt !== undefined ? Date.parse(update.finishedAt) : undefined;
  return ended !== undefined && now - ended < UPDATED_FOR_MS ? ended : undefined;
};

/** How the hub's last update ended, for someone who doesn't update it: "Updated" for a while, "Not updated" with the
 * hub's sentence for an hour. */
const told = (hub: HubState, restart: Restart | null, update: HubUpdateData | undefined, now: number): Status | null => {
  const ended = update?.finishedAt === undefined ? undefined : Date.parse(update.finishedAt);
  if (update !== undefined && ended !== undefined && now - ended < FAILED_FOR_MS && (update.state === "put_back" || update.state === "failed")) {
    return { kind: "failed", title: "Not updated", ...(update.message === undefined ? {} : { detail: update.message }), rows: [] };
  }
  const at = updatedAt(restart, update, now);
  if (at === undefined) return null;
  const to = restart?.t === "updated" ? restart.to : hub.phase === "live" ? hub.version : update?.to;
  return { kind: "current", title: "Updated", ...(to === undefined ? {} : { detail: `fleetd ${versionLabel(to)}` }), rows: [], updatedAt: at };
};

/** What Settings › Update shows; null when there is nothing to show (a member with no news, a hub that isn't there). */
export const updateSection = ({ admin, hub, machines, run, flow, ready, auto, restart, update, now = Date.now() }: UpdateInput): Status | null => {
  if (admin !== true || hub.phase !== "live") return told(hub, restart, update, now);
  const status = updateStatus({
    app: null,
    hub: { url: hub.hub, version: hub.version },
    machines: machines.map((m) => ({ machineId: m.machineId, name: m.name, nodeVersion: m.nodeVersion, online: m.status !== "offline" })),
    run,
    flow,
    ready,
    auto,
    now,
  });
  if (status.kind !== "current") return status;
  // Up to date: the Version row above says which build, so this says only that, and "Updated" while that is news.
  const at = status.updatedAt ?? updatedAt(restart, update, now);
  return at === undefined ? { kind: "current", title: status.title, rows: status.rows } : { ...status, title: "Updated", updatedAt: at };
};

/**
 * The hub's version short enough for a row's value: a release as itself, an Edge build by its day and minute
 * ("Edge · Oct 29, 23:01"). The whole of it, commit and all, is a tap away.
 */
export const shortVersion = (version: string): string => {
  const [channel, when] = versionLabel(version).split(" · ");
  return channel === "Edge" && when !== undefined ? `Edge · ${when.replace(/ UTC$/u, "")}` : (channel ?? version);
};
