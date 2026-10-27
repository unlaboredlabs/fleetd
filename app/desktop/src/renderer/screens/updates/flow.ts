// The Update button's run: the hub updates itself and then its nodes (hub_update, followed with hub_update_status
// through the hub's own restart), then, when every part came through, this app installs its update and relaunches.
// Retry updates one machine of the last run again (hub_update with its machine). The hub downloads the channel's
// newest build ahead and says so (`ready`), read on connect and every few minutes. A tiny external store, so the
// sidebar line, the notice and the sheet show the same run; the steps take their effects as deps, so they are
// unit-tested.
import { useSyncExternalStore } from "react";
import type { Call, UpdatePart, UpdateRun } from "../../../shared/contracts";
import type { UpdatesState } from "../../../shared/updates";

export type Flow =
  /** Nothing pressed in this window. */
  | { readonly phase: "idle" }
  /** Asking the hub to start. */
  | { readonly phase: "starting" }
  /** Following the hub's run; `reconnecting` while the hub restarts and doesn't answer. */
  | { readonly phase: "following"; readonly reconnecting: boolean }
  /** The hub and its nodes are done: this app downloads its update, then restarts. */
  | { readonly phase: "app" }
  /** `updated`: every machine came through and this app had nothing to install, so the sheet closes itself. */
  | { readonly phase: "finished"; readonly updated: boolean }
  /** The hub wouldn't start it: its words, and its fix. */
  | { readonly phase: "refused"; readonly message: string };

export interface FlowDeps {
  readonly call: Call;
  /** Dials the hub now, not at the next retry: after its restart it is back in seconds. */
  readonly retry: () => void;
  readonly sleep: (ms: number) => Promise<void>;
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

let flow: Flow = { phase: "idle" };
let run: UpdateRun | null = null;
let ready: string | null = null;
const listeners = new Set<() => void>();

const set = (next: { flow?: Flow; run?: UpdateRun | null; ready?: string | null }) => {
  if (next.flow !== undefined) flow = next.flow;
  if (next.run !== undefined) run = next.run;
  if (next.ready !== undefined) ready = next.ready;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useFlow = (): Flow => useSyncExternalStore(subscribe, () => flow);
export const useRun = (): UpdateRun | null => useSyncExternalStore(subscribe, () => run);
/** The channel's newest build when the hub has it downloaded and checked, ready to swap in; else null. */
export const useReady = (): string | null => useSyncExternalStore(subscribe, () => ready);
export const currentFlow = (): Flow => flow;
export const currentReady = (): string | null => ready;

/** For tests: back to a window where nothing was pressed. */
export const resetFlow = (): void => set({ flow: { phase: "idle" }, run: null, ready: null });

const going = (f: Flow): boolean => f.phase === "starting" || f.phase === "following" || f.phase === "app";

/** The hub and its nodes came through: the hub runs the new build or already did. */
export const hubUpdated = (r: UpdateRun): boolean => {
  const hub = r.parts.find((p) => p.part === "hub");
  return hub?.state === "done" || hub?.state === "current";
};

/** A machine whose update didn't come through: a part failed, was put back or skipped. Claude Code left as it is
 * (installed another way) is a calm note, not one of them. */
const leftOut = (p: UpdatePart): boolean =>
  p.state === "failed" || p.state === "rolled_back" || (p.state === "skipped" && p.part !== "claude");

/** The last run the hub knows and the build it has ready, on connect, every few minutes, and for a sheet opened
 * mid-run or after one; a run going on is followed. */
export const loadRun = async (deps: FlowDeps): Promise<void> => {
  if (going(flow)) return;
  const out = await deps.call("hub_update_status", {});
  if (!out.ok || going(flow)) return;
  set({ run: out.output.run ?? null, ready: out.output.ready ?? null });
  if (out.output.run !== undefined && out.output.run.finishedAt === undefined) await follow(deps);
};

/** The Update button. Never waits for work: the hub restarts at once, and what runs carries on by itself. */
export const startUpdate = async (deps: FlowDeps): Promise<void> => {
  if (going(flow)) return;
  set({ flow: { phase: "starting" } });
  // This app's own check runs alongside, so its update is known by the time the hub and nodes are done.
  const kind = deps.app.state()?.app.kind;
  if (kind === "idle" || kind === "current" || kind === "failed") deps.app.check();
  const out = await deps.call("hub_update", {});
  if (!out.ok) {
    const before = out.error.code === "not_found" && out.error.message.startsWith("No tool");
    const said = out.error.fix === undefined ? out.error.message : `${out.error.message} ${out.error.fix}`;
    set({ flow: { phase: "refused", message: before ? BEFORE_UPDATE : said } });
    return;
  }
  set({ run: out.output.run ?? null, ready: null });
  await follow(deps);
};

/** Retry: the hub updates this machine of the last run again, its fleetd then its Claude Code; the rest stays. */
export const retryMachine = async (deps: FlowDeps, machineId: string): Promise<void> => {
  if (going(flow)) return;
  set({ flow: { phase: "starting" } });
  const out = await deps.call("hub_update", { machine: machineId });
  if (!out.ok) {
    set({ flow: { phase: "refused", message: out.error.fix === undefined ? out.error.message : `${out.error.message} ${out.error.fix}` } });
    return;
  }
  set({ run: out.output.run ?? null });
  await follow(deps, false);
};

/** `withApp`: this app installs its update at the end, when every part came through. */
const follow = async (deps: FlowDeps, withApp = true): Promise<void> => {
  set({ flow: { phase: "following", reconnecting: false } });
  while (run !== null && run.finishedAt === undefined) {
    await deps.sleep(FOLLOW_EVERY_MS);
    const out = await deps.call("hub_update_status", {});
    if (out.ok) {
      set({ flow: { phase: "following", reconnecting: false }, run: out.output.run ?? run });
    } else {
      // The hub is restarting: keep what it last said, and dial it again.
      set({ flow: { phase: "following", reconnecting: true } });
      deps.retry();
    }
  }
  // A part that failed or was put back stays on screen: restarting this app now would take its words away. This app's
  // own update is still there to install by hand.
  if (run === null || !hubUpdated(run) || run.parts.some((p) => p.state === "failed" || p.state === "rolled_back")) {
    set({ flow: { phase: "finished", updated: false } });
    return;
  }
  const updated = !run.parts.some(leftOut);
  if (!withApp) {
    set({ flow: { phase: "finished", updated } });
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
    set({ flow: { phase: "app" } });
    // Restarts once the download is in (at once when it is); the composer keeps every draft.
    deps.app.install();
    return;
  }
  set({ flow: { phase: "finished", updated } });
};
