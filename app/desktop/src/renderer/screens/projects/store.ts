// New bot's state, kept outside the dialog so a clone carries on (and still reports its end) while it is hidden.
// Every entry point opens it with openAddProject(); `#/projects/add` does too, over the screen it was opened from
// (ProjectsHost), which stays as it was. The calls go through the data layer; the flow itself is create.ts.

import { useEffect, useSyncExternalStore } from "react";
import type { DataLayer } from "../../src/data/queries";
import { useDataLayer } from "../../src/data/react";
import { projectKey, type DataState } from "../../src/data/store";
import { toast } from "../../ui";
import type { Machine } from "./contracts";
import { botName, busy, createStep, hubMessages, initialCreate, outcomeLine, repoKey, type Call, type CreateMsg, type CreateState, type HubView, type RepoDraft } from "./create";
import { toHash } from "../shell/routes";
import { addSource, machineIdFromHost, omit, tilde } from "./source";

export interface Note {
  readonly text: string;
  readonly problem: boolean;
}

export interface AddUi {
  readonly add: CreateState;
  readonly name: string;
  readonly repos: ReadonlyArray<RepoDraft>;
  /** The add-a-repo field's text; null while it is closed. */
  readonly adding: string | null;
  /** A line under the repos: where a dropped folder came from, or why it can't be added. */
  readonly note?: Note;
  /** Why Create didn't go: no name, no machine. Cleared by the next edit. */
  readonly refused?: string;
  /** The machine picked; absent: the hub's suggestion. */
  readonly machine?: string;
  /** The dialog is on screen. */
  readonly open: boolean;
  /** This computer's host name, once main has said. */
  readonly hostName?: string;
}

let ui: AddUi = { add: initialCreate, name: "", repos: [], adding: null, open: false };
const listeners = new Set<() => void>();

const set = (next: AddUi) => {
  ui = next;
  for (const l of listeners) l();
};

/** project_add and project_repo_add may take a while: both can run gh on the hub. */
const CALL_MS = 120_000;

// The data layer (E1) is the one source of hub data; the flow reads its store and never subscribes to main.
let layer: DataLayer | undefined;
const hubState = (): DataState | undefined => layer?.store.getState();

/** A machine's name from the store, else its id. */
export const machineName = (id: string): string => hubState()?.machines[id]?.name ?? id;

/** The bot just made, to open once the hub's snapshot lists it, so its chat never shows as missing first. */
let toOpen: { machineId: string; projectId: string } | undefined;

const openWhenListed = () => {
  const next = toOpen;
  if (next === undefined || hubState()?.projects[projectKey(next)] === undefined) return;
  toOpen = undefined;
  window.location.hash = toHash({ id: "project", project: next, message: null });
};

/** A fresh, closed dialog: what the next New bot opens on. */
const fresh = (): AddUi => ({ add: createStep(ui.add, { t: "reset" })[0], name: "", repos: [], adding: null, open: false, ...(ui.hostName === undefined ? {} : { hostName: ui.hostName }) });

const dispatch = (msg: CreateMsg) => {
  const before = ui.add;
  const [next, calls] = createStep(ui.add, msg);
  set({ ...ui, add: next });
  for (const c of calls) run(c);
  if (before.phase.kind === "creating" && next.phase.kind === "made") {
    // Made: its chat opens behind the dialog at once, which stays to show its repos coming in, if it has any.
    toOpen = next.phase.bot.project;
    openWhenListed();
    if (next.jobs.every((j) => j.state.t === "added")) {
      // Nothing more to show, open or hidden: one toast, and the next New bot starts fresh.
      const done = next.phase.bot.title;
      set(fresh());
      toast({ title: `${done} is ready`, tone: "success" });
      return;
    }
  }
  if (!ui.open) announce(before);
};

/** Each call goes through the data layer, whose `call` is the one way to the hub. */
const run = (c: Call) => {
  const data = layer;
  if (data === undefined) return;
  const out = c.kind === "create" ? data.call("project_add", c.input, { timeoutMs: CALL_MS }) : data.call("project_repo_add", c.input, { timeoutMs: CALL_MS });
  void out.then((outcome) => dispatch({ t: "answer", call: c, outcome }));
};

/** The dialog is hidden while the repos finish: say how they ended, in a toast that brings back what failed. */
const announce = (before: CreateState) => {
  if (outcomeLine(before) !== null) return;
  const line = outcomeLine(ui.add);
  if (line !== null) {
    toast({ title: line.title, tone: line.problem ? "danger" : "success", ...(line.problem ? { action: { label: "Show", onClick: showAddProject } } : {}) });
    // All in: nothing is left to show, so the next New bot starts fresh.
    if (!line.problem) set(fresh());
    return;
  }
  const p = ui.add.phase;
  if (before.phase.kind === "creating" && p.kind === "failed") {
    toast({ title: `Couldn't create ${p.title}`, description: p.message, tone: "danger", action: { label: "Show", onClick: showAddProject } });
  }
};

const view = (d: DataState): HubView => ({ live: d.hub.phase === "live", fresh: d.fresh, projects: d.projects, events: d.events });

/** Starts feeding the flow from the layer's store; once per layer. */
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
    openWhenListed();
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
  return useSyncExternalStore(subscribe, addUi);
};

/** The dialog's state as it is now. */
export const addUi = (): AddUi => ui;

/** The machine a prefill goes to: the one it names (a removed bot's), else this computer for a path. */
export const prefillMachine = (text: string, given: string | undefined, local: string | undefined): string | undefined =>
  given ?? (/^[/~.]/u.test(text.trim()) ? local : undefined);

/**
 * Opens New bot from anywhere: the sidebar's +, the palette, the File menu, a drop on the window. A `prefill` (a
 * pasted or dropped URL or path) goes in its repos unless something is being made.
 */
export const openAddProject = (prefill?: { text: string; note?: Note; machine?: string }): void => {
  // A bot made or refused while the dialog was hidden is done with: a new one starts on a fresh form.
  if (!busy(ui.add) && ui.add.phase.kind !== "form") set(fresh());
  if (prefill && !busy(ui.add)) {
    const machine = prefillMachine(prefill.text, prefill.machine, localMachine()?.machineId);
    const src = addSource(prefill.text);
    const repo: RepoDraft | null = src === null ? null : src.kind === "github" ? { kind: "clone", repo: src.repo } : { kind: "folder", path: src.path };
    const fresh = ui.add.phase.kind === "form" ? ui : { ...ui, add: createStep(ui.add, { t: "reset" })[0] };
    const rest = omit(fresh, "note", "machine", "refused");
    set({
      ...rest,
      open: true,
      repos: repo === null ? fresh.repos : withRepo(fresh.repos, repo),
      ...(prefill.note ? { note: prefill.note } : {}),
      ...(machine === undefined ? {} : { machine }),
    });
  } else if (!ui.open) set({ ...ui, open: true });
};

/** A toast's Show: the dialog as it was left, its failed repos or refusal still there. */
export const showAddProject = (): void => {
  if (!ui.open) set({ ...ui, open: true });
};

/** Esc, Cancel, Done, or a bot opened from it: the screen behind is as it was. */
export const closeAddProject = (): void => {
  if (!ui.open) return;
  // A finished or untouched dialog starts fresh next time; one still adding keeps going out of sight.
  if (busy(ui.add)) {
    set({ ...ui, open: false });
    return;
  }
  set(fresh());
};

const withRepo = (repos: ReadonlyArray<RepoDraft>, r: RepoDraft): ReadonlyArray<RepoDraft> => (repos.some((x) => repoKey(x) === repoKey(r)) ? repos : [...repos, r]);

export const setName = (name: string): void => set({ ...omit(ui, "refused"), name });

/** The add field opened (""), typed in, or closed (null). */
export const setAdding = (adding: string | null): void => set({ ...omit(ui, "note"), adding });

/** A repo into the list, the add field closed. */
export const addRepo = (r: RepoDraft): void => set({ ...omit(ui, "note", "refused"), repos: withRepo(ui.repos, r), adding: null });

export const removeRepo = (key: string): void => set({ ...omit(ui, "note"), repos: ui.repos.filter((r) => repoKey(r) !== key) });

/**
 * Another machine for the bot. The folders listed are on the one it was on (`from`), so they come out, and a line
 * says which; a GitHub repo clones onto whichever machine it is.
 */
export const pickMachine = (machine: string, from?: string): void => {
  const moved = from !== undefined && from !== machine ? ui.repos.flatMap((r) => (r.kind === "folder" ? [r.path] : [])) : [];
  if (moved.length === 0) {
    set({ ...omit(ui, "refused"), machine });
    return;
  }
  const paths = moved.map(tilde).join(", ");
  const note = { text: `Took out ${paths}: ${moved.length === 1 ? "a folder" : "folders"} on ${machineName(from ?? "")}, not ${machineName(machine)}.`, problem: true };
  set({ ...omit(ui, "refused"), machine, repos: ui.repos.filter((r) => r.kind !== "folder"), note });
};

export const setNote = (note: Note | undefined): void => set(note === undefined ? omit(ui, "note") : { ...ui, note });

/** Create: the bot and its repos, or why not yet. `typed`: a repo left in the add field, which goes in the list first. */
export const create = (machineId: string | undefined, why?: string, typed?: RepoDraft): void => {
  const repos = typed === undefined ? ui.repos : withRepo(ui.repos, typed);
  const shown = typed === undefined ? ui : { ...omit(ui, "note"), repos, adding: null };
  const name = botName(ui.name, repos);
  const refused = why ?? (machineId === undefined ? "No machine is online: start fleetd on one of your machines." : name === "" ? "Name it, or add a repo." : undefined);
  if (refused !== undefined || machineId === undefined) {
    set({ ...shown, refused: refused ?? "" });
    return;
  }
  set(shown);
  dispatch({ t: "start", draft: { name, machineId, repos } });
};

/** Why Create didn't go, said over its button until the next edit. */
export const refuseCreate = (why: string): void => set({ ...ui, refused: why });

export const retryRepo = (key: string, useExisting = false): void => dispatch({ t: "retry", key, useExisting });

export const dismissRepo = (key: string): void => dispatch({ t: "dismiss", key });

export const back = (): void => dispatch({ t: "back" });

/** This computer, when it is one of the hub's machines (by name, or the id fleetd init derives from its host name). */
export const localMachine = (): Machine | undefined => {
  const host = ui.hostName;
  if (host === undefined || host === "") return undefined;
  const id = machineIdFromHost(host);
  return Object.values(hubState()?.machines ?? {}).find((m) => m.name.toLowerCase() === host.toLowerCase() || m.machineId === id);
};

/** A bot opens as its lead chat, the dialog closed. */
export const openProject = (machineId: string, projectId: string): void => {
  closeAddProject();
  window.location.hash = toHash({ id: "project", project: { machineId, projectId }, message: null });
};
