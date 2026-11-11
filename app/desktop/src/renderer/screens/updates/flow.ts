// The Update button's run: the hub updates itself and then its machines (hub_update, followed with hub_update_status
// through the hub's own restart), each machine once its agents finish the step they're on, then, when every part came
// through, this app installs its update and relaunches. Pressed again after a failure it does the same: the hub
// brings whatever is behind to its build. A run that stopped moving is started over (hub_update with startOver). The
// hub downloads the channel's newest build ahead and says so (`ready`), read on connect, every few minutes and
// whenever the hub says an update began or ended. A tiny external store, so every surface shows the same run; the
// steps take their effects as deps, so they are unit-tested.
import { useSyncExternalStore } from "react";
import type { Call, HubUpdateOutput, UpdateRun } from "../../../shared/contracts";
import type { UpdatesState } from "../../../shared/updates";

export type Flow =
  /** Nothing pressed in this window. */
  | { readonly phase: "idle" }
  /** Asking the hub to start. */
  | { readonly phase: "starting" }
  /**
   * Following the hub's run; `reconnecting` while the hub restarts and doesn't answer. `since`: when this window last
   * saw the run change, epoch ms; `leftOver`: the hub says nothing drives it any more.
   */
  | { readonly phase: "following"; readonly reconnecting: boolean; readonly since?: number; readonly leftOver?: boolean }
  /** The hub and its machines are done: this app downloads its update, then restarts. */
  | { readonly phase: "app" }
  | { readonly phase: "finished" }
  /** The hub wouldn't start it: its words, and its fix. */
  | { readonly phase: "refused"; readonly message: string };

/** Update automatically, as the hub keeps it. */
export interface Auto {
  readonly on: boolean;
  /** When the build that is ready installs by itself, ISO; null with nothing due. */
  readonly at: string | null;
  /** Why automatic updates hold back now, in the hub's sentence; null while they don't. */
  readonly held: string | null;
}

export interface FlowDeps {
  /** Whose: the data layer's hub id; "" when absent (one hub). */
  readonly hub?: string;
  readonly call: Call;
  /** Dials the hub now, not at the next retry: after its restart it is back in seconds. */
  readonly retry: () => void;
  readonly sleep: (ms: number) => Promise<void>;
  /** Epoch ms; Date.now when absent. */
  readonly now?: () => number;
  readonly app: {
    readonly state: () => UpdatesState | null;
    readonly check: () => void;
    readonly install: () => void;
  };
}

/** How often the run is read while it goes on: each part settles within a second or so of the last, and a read is one
 * small call on the open socket. */
export const FOLLOW_EVERY_MS = 500;
/** How often the hub is asked whether it has a newer build ready: it looks every 10 minutes. */
export const READY_EVERY_MS = 10 * 60_000;
/** How long the end of a run waits for this app's own check, so an update it is about to find isn't missed. */
export const APP_CHECK_WAIT_MS = 60_000;
const APP_CHECK_EVERY_MS = 1_000;

/** What a hub from before hub_update gets: `fleetd update` there once, the first time for everyone. */
export const BEFORE_UPDATE =
  "The hub runs a fleetd from before the Update button. Run `fleetd update` on the hub's machine once; after that, Update does the rest.";

/** One hub's: each hub updates on its own, so each says its own. */
interface Slot {
  readonly flow: Flow;
  readonly run: UpdateRun | null;
  readonly ready: string | null;
  /** Null until the hub said (or an older hub, which never does). */
  readonly auto: Auto | null;
  /** Bumped by each follow: an earlier one, still waiting on the hub, then stops (Start over follows the new run). */
  readonly following: number;
}

const EMPTY: Slot = { flow: { phase: "idle" }, run: null, ready: null, auto: null, following: 0 };
const slots = new Map<string, Slot>();
const listeners = new Set<() => void>();

const slotOf = (hub: string): Slot => slots.get(hub) ?? EMPTY;

/** What `next` names changes; one left undefined (an older hub's answer without it) stays as it was. */
const set = (hub: string, next: { readonly [K in keyof Slot]?: Slot[K] | undefined }) => {
  const kept = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as Partial<Slot>;
  slots.set(hub, { ...slotOf(hub), ...kept });
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** `hub`: the data layer's hub id (useDataLayer().hub); "" with one hub, as the phone app has (FlowDeps' default). */
export const useFlow = (hub = ""): Flow => useSyncExternalStore(subscribe, () => slotOf(hub).flow);
export const useRun = (hub = ""): UpdateRun | null => useSyncExternalStore(subscribe, () => slotOf(hub).run);
/** The channel's newest build when the hub has it downloaded and checked, ready to swap in; else null. */
export const useReady = (hub = ""): string | null => useSyncExternalStore(subscribe, () => slotOf(hub).ready);
export const useAuto = (hub = ""): Auto | null => useSyncExternalStore(subscribe, () => slotOf(hub).auto);
export const currentFlow = (hub = ""): Flow => slotOf(hub).flow;
export const currentReady = (hub = ""): string | null => slotOf(hub).ready;
export const currentRun = (hub = ""): UpdateRun | null => slotOf(hub).run;
export const currentAuto = (hub = ""): Auto | null => slotOf(hub).auto;

/** For tests: back to a window where nothing was pressed. */
export const resetFlow = (): void => {
  slots.clear();
  for (const listener of listeners) listener();
};

const going = (f: Flow): boolean => f.phase === "starting" || f.phase === "following" || f.phase === "app";

/** The hub came through: it runs the new build or already did. */
export const hubUpdated = (r: UpdateRun): boolean => {
  const hub = r.parts.find((p) => p.part === "hub");
  return hub?.state === "done" || hub?.state === "current";
};

/** Update automatically in an answer; undefined when it has no settings (an older hub), so the last one stays. */
const autoOf = (out: HubUpdateOutput): Auto | undefined =>
  out.settings === undefined ? undefined : { on: out.settings.auto, at: out.autoAt ?? null, held: out.skipReason ?? null };

const said = (error: { readonly message: string; readonly fix?: string | undefined }): string => (error.fix === undefined ? error.message : `${error.message} ${error.fix}`);

/** The last run the hub knows, the build it has ready and Update automatically; a run going on is followed. */
export const loadRun = async (deps: FlowDeps): Promise<void> => {
  const hub = deps.hub ?? "";
  if (going(slotOf(hub).flow)) return;
  const out = await deps.call("hub_update_status", {});
  if (!out.ok || going(slotOf(hub).flow)) return;
  set(hub, { run: out.output.run ?? null, ready: out.output.ready ?? null, auto: autoOf(out.output) });
  // Followed, never ended with this app's restart: only Update pressed in this window restarts it.
  if (out.output.run !== undefined && out.output.run.finishedAt === undefined) await follow(deps, false);
};

/**
 * The Update button: the hub restarts at once, each machine once its agents finish their step (2 minutes at most),
 * then this app. `over` (Start over) first ends the run this window follows, which stopped moving.
 */
export const startUpdate = async (deps: FlowDeps, over = false): Promise<void> => {
  const hub = deps.hub ?? "";
  const slot = slotOf(hub);
  if (over ? slot.flow.phase !== "following" : going(slot.flow)) return;
  set(hub, { flow: { phase: "starting" }, following: slot.following + 1 });
  // This app's own check runs alongside, so its update is known by the time the hub and its machines are done.
  const kind = deps.app.state()?.app.kind;
  if (kind === "idle" || kind === "current" || kind === "failed") deps.app.check();
  const out = await deps.call("hub_update", over ? { startOver: true } : {});
  if (!out.ok) {
    const before = out.error.code === "not_found" && out.error.message.startsWith("No tool");
    set(hub, { flow: { phase: "refused", message: before ? BEFORE_UPDATE : said(out.error) } });
    return;
  }
  set(hub, { run: out.output.run ?? null, ready: null });
  await follow(deps);
};

/** Update automatically on or off: the hub keeps it. The hub's words when it refused. */
export const setAuto = async (deps: Pick<FlowDeps, "call" | "hub">, on: boolean): Promise<string | null> => {
  const out = await deps.call("hub_update_settings", { auto: on });
  if (!out.ok) return said(out.error);
  set(deps.hub ?? "", { auto: autoOf(out.output) });
  return null;
};

/** `withApp`: this app installs its update at the end, when every part came through. */
const follow = async (deps: FlowDeps, withApp = true): Promise<void> => {
  const hub = deps.hub ?? "";
  const mine = slotOf(hub).following + 1;
  set(hub, { following: mine });
  const following = () => slotOf(hub).following;
  const run = () => slotOf(hub).run;
  const now = deps.now ?? Date.now;
  let since = now();
  let leftOver = false;
  set(hub, { flow: { phase: "following", reconnecting: false, since } });
  for (let r = run(); r !== null && r.finishedAt === undefined; r = run()) {
    await deps.sleep(FOLLOW_EVERY_MS);
    if (mine !== following()) return;
    const out = await deps.call("hub_update_status", {});
    if (mine !== following()) return;
    if (out.ok) {
      const next = out.output.run ?? run();
      if (JSON.stringify(next) !== JSON.stringify(run())) since = now();
      leftOver = out.output.leftOver === true;
      set(hub, { flow: { phase: "following", reconnecting: false, since, leftOver }, run: next, ready: out.output.ready ?? null, auto: autoOf(out.output) });
    } else {
      // The hub is restarting: keep what it last said, and dial it again.
      set(hub, { flow: { phase: "following", reconnecting: true, since, leftOver } });
      deps.retry();
    }
  }
  // A part that failed stays on screen: restarting this app now would take its words away. This app's own update is
  // still there to install afterwards.
  const ended = run();
  const through = ended !== null && hubUpdated(ended) && !ended.parts.some((p) => p.state === "failed" || p.state === "rolled_back");
  if (!through || !withApp) {
    set(hub, { flow: { phase: "finished" } });
    return;
  }
  // This app's own check may still be on its way when the run ends at once (everything else already current).
  for (let waited = 0; waited < APP_CHECK_WAIT_MS; waited += APP_CHECK_EVERY_MS) {
    const kind = deps.app.state()?.app.kind;
    if (kind !== "checking" && kind !== "idle") break;
    await deps.sleep(APP_CHECK_EVERY_MS);
  }
  const app = deps.app.state()?.app.kind;
  if (app === "available" || app === "ready") {
    set(hub, { flow: { phase: "app" } });
    // Restarts once the download is in (at once when it is); the composer keeps every draft.
    deps.app.install();
    return;
  }
  set(hub, { flow: { phase: "finished" } });
};
