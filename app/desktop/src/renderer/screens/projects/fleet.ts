// The hub data these screens read: the snapshot's machines, projects and slots, each machine's latest live entry,
// and the connection. A stand-in until E1's store lands with the same data; it subscribes once, lazily, and feeds
// the add flow every frame so the add can match its events and recover after a reconnect.

import { useSyncExternalStore } from "react";
import type { HubFrame } from "../../../shared/hub";
import type { FleetSnapshot, HubEvent, Machine, MachineLive, SlotState } from "./contracts";
import { omit } from "./source";

export interface Fleet {
  readonly live: boolean;
  /** False until the first snapshot (and again while reconnecting: never show cached data as live). */
  readonly synced: boolean;
  readonly machines: ReadonlyArray<Machine>;
  readonly projects: FleetSnapshot["projects"];
  readonly slots?: SlotState;
  readonly machineLive: ReadonlyMap<string, MachineLive>;
  /** The hub's clock minus ours, from live frames. */
  readonly skewMs: number;
}

const empty: Fleet = { live: false, synced: false, machines: [], projects: [], machineLive: new Map(), skewMs: 0 };

let fleet = empty;
const listeners = new Set<() => void>();
const frameListeners = new Set<(frame: HubFrame) => void>();
let started = false;

const set = (next: Fleet) => {
  fleet = next;
  for (const l of listeners) l();
};

const SLEPT = "machine.slept";

/** Machine events change one machine in place; project add/remove ask for a fresh snapshot (rare, and small). */
const applyEvent = (f: Fleet, e: HubEvent): Fleet => {
  const id = e.machineId;
  if (id === undefined) return f;
  const patch = (change: (m: Machine) => Machine) => ({ ...f, machines: f.machines.map((m) => (m.machineId === id ? change(m) : m)) });
  switch (e.type) {
    case "machine.online":
      return patch((m) => {
        const rest = omit(m, "degradedReason");
        return { ...rest, status: "online", lastSeenAt: e.at };
      });
    case "machine.offline":
      return patch((m) => ({ ...m, status: "offline", lastSeenAt: e.at }));
    case "machine.degraded":
      return patch((m) => ({ ...m, status: "degraded", degradedReason: e.summary }));
    case SLEPT: {
      const d = e.data as { fromMs?: unknown; toMs?: unknown } | undefined;
      return typeof d?.fromMs === "number" && typeof d.toMs === "number" ? patch((m) => ({ ...m, lastSlept: { fromMs: d.fromMs as number, toMs: d.toMs as number } })) : f;
    }
    default:
      return f;
  }
};

const onFrame = (frame: HubFrame) => {
  switch (frame.t) {
    case "state": {
      const live = frame.state.phase === "live";
      set({ ...fleet, live, synced: live && fleet.synced });
      break;
    }
    case "snapshot": {
      const s = frame.snapshot as unknown as FleetSnapshot;
      const rest = omit(fleet, "slots");
      set({ ...rest, synced: true, machines: s.machines, projects: s.projects, ...(s.slots ? { slots: s.slots } : {}) });
      break;
    }
    case "event": {
      const e = frame.event as unknown as HubEvent;
      if (e.type === "project.added" || e.type === "project.removed") void window.fleetd.hub.resync();
      set(applyEvent(fleet, e));
      break;
    }
    case "live": {
      const lf = frame.frame as unknown as { at?: string; machines?: ReadonlyArray<MachineLive>; slots?: SlotState };
      if (lf.machines === undefined && lf.slots === undefined) break;
      const machineLive = new Map(fleet.machineLive);
      for (const m of lf.machines ?? []) machineLive.set(m.machineId, m);
      const hubNow = lf.at === undefined ? Number.NaN : Date.parse(lf.at);
      set({ ...fleet, machineLive, ...(lf.slots ? { slots: lf.slots } : {}), skewMs: Number.isNaN(hubNow) ? fleet.skewMs : hubNow - Date.now() });
      break;
    }
    case "error":
      break;
  }
  for (const l of frameListeners) l(frame);
};

const start = () => {
  if (started) return;
  started = true;
  window.fleetd.hub.subscribe(onFrame);
};

/** Every hub frame, after the fleet has applied it. */
export const onHubFrame = (listener: (frame: HubFrame) => void): (() => void) => {
  start();
  frameListeners.add(listener);
  return () => frameListeners.delete(listener);
};

const subscribe = (listener: () => void) => {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getFleet = (): Fleet => fleet;

export const useFleet = (): Fleet => useSyncExternalStore(subscribe, getFleet);

export const machineName = (id: string): string => fleet.machines.find((m) => m.machineId === id)?.name ?? id;
