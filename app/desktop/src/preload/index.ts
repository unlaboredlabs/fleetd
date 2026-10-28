import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type { LinkHandlerStatus, OpenTarget } from "../shared/app";
import { IPC } from "../shared/channels";
import type { CallOutcome, ConnectOutcome, DropInfo, HubFrame, OpenOutcome, SecretOutcome } from "../shared/hub";
import type { HubEntry, HubId } from "../shared/hubs";
import type { JoinHere, ThisComputer } from "../shared/joinHere";
import type { KeyStore, PairOutcome, PairStart, Probe, SetupOutcome } from "../shared/pairing";
import type { UpdatesState } from "../shared/updates";
import type { FleetdApi } from "./api";

/** Each hub's subscribers. */
const listeners = new Map<HubId, Set<(frame: HubFrame) => void>>();

// One IPC listener for all subscribers; the IpcRendererEvent (which carries `sender`) never reaches the page.
ipcRenderer.on(IPC.hubFrame, (_event: IpcRendererEvent, hub: HubId, frame: HubFrame) => {
  for (const listener of listeners.get(hub) ?? []) listener(frame);
});
const hubsListeners = new Set<(list: readonly HubEntry[]) => void>();
ipcRenderer.on(IPC.hubsChanged, (_event: IpcRendererEvent, list: readonly HubEntry[]) => {
  for (const listener of hubsListeners) listener(list);
});

const commandListeners = new Set<(id: string) => void>();
const openListeners = new Set<(target: OpenTarget) => void>();
let ready = false;

ipcRenderer.on(IPC.menuCommand, (_event: IpcRendererEvent, id: string) => {
  for (const listener of commandListeners) listener(id);
});
ipcRenderer.on(IPC.appOpen, (_event: IpcRendererEvent, target: OpenTarget) => {
  for (const listener of openListeners) listener(target);
});
const updateListeners = new Set<(state: UpdatesState) => void>();
ipcRenderer.on(IPC.updatesChanged, (_event: IpcRendererEvent, state: UpdatesState) => {
  for (const listener of updateListeners) listener(state);
});

/** Each hub's join listeners: a join's changes reach the page of the hub it joins only. */
const joinListeners = new Set<{ readonly hub: HubId; readonly listener: (state: JoinHere) => void }>();
ipcRenderer.on(IPC.machinesJoinHereChanged, (_event: IpcRendererEvent, hub: HubId, state: JoinHere) => {
  for (const l of joinListeners) if (l.hub === hub) l.listener(state);
});

const arg = (name: string): string | null => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const fixture = arg("fleetd-fixture");
/** The hubs main had as it made this window; empty when it couldn't say, and the page asks. */
const initialHubs = ((): readonly HubEntry[] => {
  try {
    const raw: unknown = JSON.parse(decodeURIComponent(arg("fleetd-hubs") ?? "[]"));
    const ok = (h: unknown): h is HubEntry =>
      typeof h === "object" && h !== null && typeof (h as HubEntry).id === "string" && typeof (h as HubEntry).label === "string";
    return Array.isArray(raw) && raw.every(ok) ? raw : [];
  } catch {
    return [];
  }
})();
const vibrancy = process.argv.includes("--fleetd-vibrancy");

const api: FleetdApi = {
  fixture,
  vibrancy,
  version: arg("fleetd-version") ?? "unknown",
  platform: process.platform === "darwin" || process.platform === "linux" || process.platform === "win32" ? process.platform : "other",
  copy: (text) => ipcRenderer.invoke(IPC.copy, text) as Promise<void>,
  secret: {
    submit: (hub, request) => ipcRenderer.invoke(IPC.secretSubmit, hub, request) as Promise<SecretOutcome>,
    projectEnv: (hub, request) => ipcRenderer.invoke(IPC.projectEnvSubmit, hub, request) as Promise<CallOutcome>,
    mcpServer: (hub, request) => ipcRenderer.invoke(IPC.mcpServerSubmit, hub, request) as Promise<CallOutcome>,
    hubLink: (hub, request) => ipcRenderer.invoke(IPC.hubLinkSubmit, hub, request) as Promise<CallOutcome>,
    googleClient: (hub, request) => ipcRenderer.invoke(IPC.googleClientSubmit, hub, request) as Promise<CallOutcome>,
    googlePubsub: (hub, request) => ipcRenderer.invoke(IPC.googlePubsubSubmit, hub, request) as Promise<CallOutcome>,
  },
  google: {
    connect: (hub, request) => ipcRenderer.invoke(IPC.googleConnect, hub, request) as Promise<CallOutcome>,
    cancel: () => ipcRenderer.invoke(IPC.googleCancel) as Promise<void>,
  },
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<OpenOutcome>,
  hubs: {
    initial: initialHubs,
    list: () => ipcRenderer.invoke(IPC.hubsList) as Promise<readonly HubEntry[]>,
    subscribe: (listener) => {
      hubsListeners.add(listener);
      return () => hubsListeners.delete(listener);
    },
    update: (hub, change) => ipcRenderer.invoke(IPC.hubsUpdate, hub, change) as Promise<ConnectOutcome>,
  },
  hub: {
    subscribe: (hub, listener) => {
      const set = listeners.get(hub) ?? new Set();
      listeners.set(hub, set);
      set.add(listener);
      // Every subscriber starts from a state and (when live) a fresh snapshot; earlier ones just see a resync.
      void ipcRenderer.invoke(IPC.hubSubscribe, hub);
      return () => {
        if (set.delete(listener) && set.size === 0) {
          listeners.delete(hub);
          void ipcRenderer.invoke(IPC.hubUnsubscribe, hub);
        }
      };
    },
    call: (hub, tool, input, options) =>
      ipcRenderer.invoke(IPC.hubCall, hub, { tool, input, ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }) as Promise<CallOutcome>,
    chat: (hub, project) => ipcRenderer.invoke(IPC.hubChat, hub, project) as Promise<void>,
    focus: (hub, workstreamId) => ipcRenderer.invoke(IPC.hubFocus, hub, workstreamId) as Promise<void>,
    watch: (hub, session) => ipcRenderer.invoke(IPC.hubWatch, hub, session) as Promise<void>,
    input: (hub, session, input) => ipcRenderer.invoke(IPC.hubInput, hub, session, input) as Promise<void>,
    resync: (hub) => ipcRenderer.invoke(IPC.hubResync, hub) as Promise<void>,
    retryNow: (hub) => ipcRenderer.invoke(IPC.hubRetryNow, hub) as Promise<void>,
    cache: {
      read: (hub) => ipcRenderer.invoke(IPC.hubCacheRead, hub) as Promise<string | null>,
      write: (hub, text) => ipcRenderer.invoke(IPC.hubCacheWrite, hub, text) as Promise<void>,
    },
    connect: (url, key, target) => ipcRenderer.invoke(IPC.hubConnect, { url, key, ...(target === undefined ? {} : { target }) }) as Promise<ConnectOutcome>,
    forget: (hub) => ipcRenderer.invoke(IPC.hubForget, hub) as Promise<void>,
  },
  pair: {
    start: () => ipcRenderer.invoke(IPC.pairStart) as Promise<PairStart>,
    probe: (hub) => ipcRenderer.invoke(IPC.pairProbe, hub) as Promise<Probe>,
    redeem: (request) => ipcRenderer.invoke(IPC.pairRedeem, request) as Promise<PairOutcome>,
    auto: () => ipcRenderer.invoke(IPC.pairAuto) as Promise<PairOutcome>,
    store: () => ipcRenderer.invoke(IPC.pairStore) as Promise<KeyStore>,
    setup: () => ipcRenderer.invoke(IPC.pairSetup) as Promise<SetupOutcome>,
  },
  system: {
    hostName: () => ipcRenderer.invoke(IPC.systemHostName) as Promise<string>,
  },
  machines: {
    joinHere: (hub, machineId) => ipcRenderer.invoke(IPC.machinesJoinHere, hub, machineId) as Promise<JoinHere>,
    joinHereState: (hub) => ipcRenderer.invoke(IPC.machinesJoinHereState, hub) as Promise<JoinHere | null>,
    thisComputer: () => ipcRenderer.invoke(IPC.machinesThisComputer) as Promise<ThisComputer>,
    onJoinHere: (hub, listener) => {
      const entry = { hub, listener };
      joinListeners.add(entry);
      return () => joinListeners.delete(entry);
    },
  },
  projects: {
    pickFolder: () => ipcRenderer.invoke(IPC.projectsPickFolder) as Promise<string | null>,
    // The page passes the dropped File, never a path: only a File from a real drop (or file picker) has one, so the
    // page can't point main at a path of its choosing.
    readDrop: (file) => {
      const path = webUtils.getPathForFile(file);
      return path === "" ? Promise.resolve<DropInfo>({ kind: "other" }) : (ipcRenderer.invoke(IPC.projectsReadDrop, path) as Promise<DropInfo>);
    },
  },
  updates: {
    state: () => ipcRenderer.invoke(IPC.updatesState) as Promise<UpdatesState>,
    subscribe: (listener) => {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    },
    check: () => ipcRenderer.invoke(IPC.updatesCheck) as Promise<void>,
    install: () => ipcRenderer.invoke(IPC.updatesInstall) as Promise<void>,
    keep: () => ipcRenderer.invoke(IPC.updatesKeep) as Promise<void>,
  },
  app: {
    onMenuCommand: (listener) => {
      commandListeners.add(listener);
      return () => commandListeners.delete(listener);
    },
    onOpen: (listener) => {
      openListeners.add(listener);
      // Main holds a launch link until the page listens; a reload asks again and gets nothing new.
      if (!ready) {
        ready = true;
        void ipcRenderer.invoke(IPC.appReady);
      }
      return () => openListeners.delete(listener);
    },
    notify: (request) => ipcRenderer.invoke(IPC.appNotify, request) as Promise<boolean>,
    setBadge: (count) => ipcRenderer.invoke(IPC.appBadge, count) as Promise<void>,
    sessionWindow: (request) => ipcRenderer.invoke(IPC.appSessionWindow, request) as Promise<void>,
    setTheme: (mode) => ipcRenderer.invoke(IPC.appTheme, mode) as Promise<void>,
    linkHandler: (claim) => ipcRenderer.invoke(IPC.appLinkHandler, claim) as Promise<LinkHandlerStatus>,
    presence: (on) => ipcRenderer.invoke(IPC.appPresence, on) as Promise<boolean>,
    setMenuState: (enabled) => ipcRenderer.invoke(IPC.appMenuState, enabled) as Promise<void>,
    logError: (report) => (ipcRenderer.invoke(IPC.appLog, report) as Promise<void>).catch(() => undefined),
  },
};

contextBridge.exposeInMainWorld("fleetd", api);
