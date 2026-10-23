// The one add in flight and the sheet's own state, kept outside the sheet so a clone carries on (and still reports
// its end) while the sheet is hidden. Every entry point opens it with openAddProject().

import { useEffect, useSyncExternalStore } from "react";
import type { DataLayer } from "../../src/data/queries";
import { useDataLayer } from "../../src/data/react";
import type { DataState } from "../../src/data/store";
import { toast } from "../../ui";
import type { Machine } from "./contracts";
import type { Request } from "./discovery";
import { toHash } from "../shell/routes";
import { hubMessages, initialAdd, step, type AddMsg, type AddState, type Call, type HubView } from "./flow";
import { machineIdFromHost, omit } from "./source";

export const ADD_ROUTE = "#/projects/add";

export interface Note {
  readonly text: string;
  readonly problem: boolean;
}

export interface AddUi {
  readonly add: AddState;
  /** What is typed in the field. */
  readonly text: string;
  readonly note?: Note;
  /** The machine picked for a clone or a typed path; absent: the hub's suggestion. */
  readonly machine?: string;
  /** The sheet is on screen. */
  readonly open: boolean;
  /** This computer's host name, once main has said. */
  readonly hostName?: string;
}

let ui: AddUi = { add: initialAdd, text: "", open: false };
const listeners = new Set<() => void>();
/** Where the sheet goes back to when closed. */
let returnTo = "#/";

const set = (next: AddUi) => {
  ui = next;
  for (const l of listeners) l();
};

/** project_add may take a while, its dry run too: both run gh on the hub. */
const CALL_MS = 120_000;

// The data layer (E1) is the one source of hub data; the add flow reads its store and never subscribes to main.
let layer: DataLayer | undefined;
const hubState = (): DataState | undefined => layer?.store.getState();

/** A machine's name from the store, else its id. */
export const machineName = (id: string): string => hubState()?.machines[id]?.name ?? id;

const dispatch = (msg: AddMsg) => {
  const before = ui.add.phase.kind;
  const [next, calls] = step(ui.add, msg, machineName);
  set({ ...ui, add: next });
  if (!ui.open && before === "working") announce();
  for (const c of calls) run(c);
};

/** Each step's call goes through the data layer, whose `call` is the one way to the hub. */
const run = (c: Call) => {
  const data = layer;
  if (data === undefined) return;
  void data.call("project_add", c.input, { timeoutMs: CALL_MS }).then((outcome) => dispatch({ t: "answer", call: c, outcome }));
};

/** The sheet is hidden while an add ends: say so in a toast that brings it back. */
const announce = () => {
  const p = ui.add.phase;
  if (p.kind === "ready") {
    toast({ title: `${p.ready.title} is ready on ${p.ready.machine}`, tone: "success", action: { label: "Show", onClick: () => openAddProject() } });
  } else if (p.kind === "unlisted") {
    toast({ title: `${p.what} isn't on the hub yet`, description: "If the clone was still running, it appears when it finishes; Machines shows any error.", action: { label: "Show", onClick: () => openAddProject() } });
  } else if (p.kind === "failed") {
    toast({ title: `Couldn't add ${p.what}`, description: p.failure.message, tone: "danger", action: { label: "Show", onClick: () => openAddProject() } });
  }
};

const view = (d: DataState): HubView => ({ live: d.hub.phase === "live", fresh: d.fresh, projects: d.projects, events: d.events });

/** Starts feeding the add flow from the layer's store; once per layer. */
const connect = (next: DataLayer): void => {
  if (layer === next) return;
  layer = next;
  let prev: HubView | undefined;
  let lastSeq: number | undefined;
  const onChange = (d: DataState) => {
    const now = view(d);
    // The first look takes the connection as it is now: frames that came before this listened are not replayed.
    if (prev === undefined) lastSeq = d.cursor;
    const msgs = hubMessages(prev, now, lastSeq);
    prev = now;
    for (const msg of msgs) {
      if (msg.t === "event") lastSeq = msg.event.seq;
      dispatch(msg);
    }
  };
  next.store.subscribe(onChange);
  onChange(next.store.getState());
  void window.fleetd.system.hostName().then((hostName) => set({ ...ui, hostName }));
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useAddUi = (): AddUi => {
  const data = useDataLayer();
  useEffect(() => connect(data), [data]);
  return useSyncExternalStore(subscribe, () => ui);
};

/**
 * Opens Add project from anywhere: the sidebar's + Add, the palette, the File menu, a drop on the window. A
 * `prefill` (a pasted or dropped URL or path) replaces what is typed unless an add is running.
 */
/** The machine a prefill goes to: the one it names (a removed project's), else this computer for a path. */
export const prefillMachine = (text: string, given: string | undefined, local: string | undefined): string | undefined =>
  given ?? (/^[/~.]/u.test(text.trim()) ? local : undefined);

export const openAddProject = (prefill?: { text: string; note?: Note; machine?: string }): void => {
  if (window.location.hash !== ADD_ROUTE) returnTo = window.location.hash || "#/";
  const working = ui.add.phase.kind === "working";
  if (prefill && !working) {
    const machine = prefillMachine(prefill.text, prefill.machine, localMachine()?.machineId);
    const rest = omit(ui, "note", "machine");
    set({
      ...rest,
      text: prefill.text,
      ...(prefill.note ? { note: prefill.note } : {}),
      ...(machine === undefined ? {} : { machine }),
      add: ui.add.phase.kind === "pick" ? ui.add : { ...ui.add, phase: { kind: "pick" } },
    });
  }
  window.location.hash = ADD_ROUTE;
};

export const sheetShown = (): void => set({ ...ui, open: true });

export const sheetHidden = (): void => {
  if (!ui.open) return;
  // A finished or untouched sheet starts fresh next time; one still adding keeps going out of sight.
  const fresh = ui.add.phase.kind !== "working";
  const rest = omit(ui, "note", "machine");
  set(fresh ? { ...rest, open: false, text: "", add: step(ui.add, { t: "reset" }, machineName)[0] } : { ...ui, open: false });
  if (!fresh) toast({ title: `Still adding ${ui.add.phase.kind === "working" ? ui.add.phase.job.what : "the project"}`, description: "Add project… shows its progress." });
};

export const closeAddProject = (): void => {
  window.location.hash = returnTo === ADD_ROUTE ? "#/" : returnTo;
};

export const setText = (text: string): void => {
  const rest = omit(ui, "note");
  set({ ...rest, text });
};

export const pickMachine = (machine: string): void => set({ ...ui, machine });

export const startAdd = (request: Request, path: string): void => dispatch({ t: "start", request, path });

export const back = (): void => dispatch({ t: "back" });

export const addAnother = (): void => {
  const rest = omit(ui, "note");
  set({ ...rest, text: "" });
  dispatch({ t: "reset" });
};

/** This computer, when it is one of the hub's machines (by name, or the id fleetd init derives from its host name). */
export const localMachine = (): Machine | undefined => {
  const host = ui.hostName;
  if (host === undefined || host === "") return undefined;
  const id = machineIdFromHost(host);
  return Object.values(hubState()?.machines ?? {}).find((m) => m.name.toLowerCase() === host.toLowerCase() || m.machineId === id);
};

/** A project opens as its lead chat. */
export const openProject = (machineId: string, projectId: string): void => {
  window.location.hash = toHash({ id: "project", project: { machineId, projectId }, message: null });
};
