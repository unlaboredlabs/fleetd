// The one add in flight and the sheet's own state, kept outside the sheet so a clone carries on (and still reports
// its end) while the sheet is hidden. Every entry point opens it with openAddProject().

import { useSyncExternalStore } from "react";
import { toast } from "../../ui";
import type { HubEvent, Machine } from "./contracts";
import type { Request } from "./discovery";
import { onHubFrame, getFleet, machineName } from "./fleet";
import { initialAdd, step, type AddMsg, type AddState, type Call } from "./flow";
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
let returnTo = "#/board";

const set = (next: AddUi) => {
  ui = next;
  for (const l of listeners) l();
};

/** Calls that may take a while: discovery runs gh and scans every worker. */
const CALL_MS = 120_000;

const dispatch = (msg: AddMsg) => {
  const before = ui.add.phase.kind;
  const [next, calls] = step(ui.add, msg, machineName);
  set({ ...ui, add: next });
  if (!ui.open && before === "working") announce();
  for (const c of calls) run(c);
};

const run = (c: Call) => {
  void window.fleetd.hub.call(c.tool, c.input, { timeoutMs: CALL_MS }).then((outcome) => dispatch({ t: "answer", call: c, outcome }));
};

/** The sheet is hidden while an add ends: say so in a toast that brings it back. */
const announce = () => {
  const p = ui.add.phase;
  if (p.kind === "ready") {
    toast({ title: `${p.ready.title} is ready on ${p.ready.machine}`, tone: "success", action: { label: "Show", onClick: () => openAddProject() } });
  } else if (p.kind === "failed") {
    toast({ title: `Couldn't add ${p.what}`, description: p.failure.message, tone: "danger", action: { label: "Show", onClick: () => openAddProject() } });
  }
};

let wired = false;
const wire = () => {
  if (wired) return;
  wired = true;
  onHubFrame((frame) => {
    if (frame.t === "state") dispatch({ t: "live", live: frame.state.phase === "live" });
    else if (frame.t === "snapshot") dispatch({ t: "snapshot", cursor: frame.snapshot.cursor });
    else if (frame.t === "event") dispatch({ t: "event", event: frame.event as unknown as HubEvent });
  });
  void window.fleetd.system.hostName().then((hostName) => set({ ...ui, hostName }));
};

const subscribe = (listener: () => void) => {
  wire();
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useAddUi = (): AddUi => useSyncExternalStore(subscribe, () => ui);

/**
 * Opens Add project from anywhere: the sidebar's + Add, the palette, the empty board, the File menu, a drop. A
 * `prefill` (a pasted or dropped URL or path) replaces what is typed unless an add is running.
 */
export const openAddProject = (prefill?: { text: string; note?: Note }): void => {
  wire();
  if (window.location.hash !== ADD_ROUTE) returnTo = window.location.hash || "#/board";
  const working = ui.add.phase.kind === "working";
  if (prefill && !working) {
    const local = localMachine();
    const isPath = /^[/~.]/u.test(prefill.text.trim());
    const rest = omit(ui, "note");
    set({
      ...rest,
      text: prefill.text,
      ...(prefill.note ? { note: prefill.note } : {}),
      ...(isPath && local ? { machine: local.machineId } : {}),
      add: ui.add.phase.kind === "pick" ? ui.add : { ...ui.add, phase: { kind: "pick" } },
    });
  }
  window.location.hash = ADD_ROUTE;
};

/** The sheet mounted: look again for repos unless an add is on screen. */
export const sheetShown = (): void => {
  wire();
  set({ ...ui, open: true });
  if (ui.add.phase.kind === "pick") dispatch({ t: "discover" });
};

export const sheetHidden = (): void => {
  if (!ui.open) return;
  // A finished or untouched sheet starts fresh next time; one still adding keeps going out of sight.
  const fresh = ui.add.phase.kind !== "working";
  const rest = omit(ui, "note", "machine");
  set(fresh ? { ...rest, open: false, text: "", add: step(ui.add, { t: "reset" }, machineName)[0] } : { ...ui, open: false });
  if (!fresh) toast({ title: `Still adding ${ui.add.phase.kind === "working" ? ui.add.phase.job.what : "the project"}`, description: "Add project… shows its progress." });
};

export const closeAddProject = (): void => {
  window.location.hash = returnTo === ADD_ROUTE ? "#/board" : returnTo;
};

export const setText = (text: string): void => {
  const rest = omit(ui, "note");
  set({ ...rest, text });
};

export const setNote = (note: Note | undefined): void => {
  const rest = omit(ui, "note");
  set(note ? { ...rest, note } : rest);
};

export const pickMachine = (machine: string): void => set({ ...ui, machine });

export const startAdd = (request: Request, path: string): void => dispatch({ t: "start", request, path });

export const back = (): void => dispatch({ t: "back" });

export const addAnother = (): void => {
  const rest = omit(ui, "note");
  set({ ...rest, text: "" });
  dispatch({ t: "reset" });
  dispatch({ t: "discover" });
};

/** This computer, when it is one of the hub's machines (by name, or the id fleetd init derives from its host name). */
export const localMachine = (): Machine | undefined => {
  const host = ui.hostName;
  if (host === undefined || host === "") return undefined;
  const id = machineIdFromHost(host);
  return getFleet().machines.find((m) => m.name.toLowerCase() === host.toLowerCase() || m.machineId === id);
};

export const openProject = (machineId: string, projectId: string): void => {
  window.location.hash = `#/board/${encodeURIComponent(machineId)}/${encodeURIComponent(projectId)}`;
};
