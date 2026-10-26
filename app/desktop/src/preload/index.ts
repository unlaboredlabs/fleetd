import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type { LinkHandlerStatus, OpenTarget } from "../shared/app";
import { IPC } from "../shared/channels";
import type { CallOutcome, ConnectOutcome, DropInfo, HubFrame, OpenOutcome, SecretOutcome } from "../shared/hub";
import type { KeyStore, PairOutcome, PairStart, Probe, SetupOutcome } from "../shared/pairing";
import type { UpdatesState } from "../shared/updates";
import type { FleetdApi } from "./api";

const listeners = new Set<(frame: HubFrame) => void>();

// One IPC listener for all subscribers; the IpcRendererEvent (which carries `sender`) never reaches the page.
ipcRenderer.on(IPC.hubFrame, (_event: IpcRendererEvent, frame: HubFrame) => {
  for (const listener of listeners) listener(frame);
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

const arg = (name: string): string | null => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const fixture = arg("fleetd-fixture");
const vibrancy = process.argv.includes("--fleetd-vibrancy");

const api: FleetdApi = {
  fixture,
  vibrancy,
  version: arg("fleetd-version") ?? "unknown",
  platform: process.platform === "darwin" || process.platform === "linux" || process.platform === "win32" ? process.platform : "other",
  copy: (text) => ipcRenderer.invoke(IPC.copy, text) as Promise<void>,
  secret: {
    submit: (request) => ipcRenderer.invoke(IPC.secretSubmit, request) as Promise<SecretOutcome>,
    projectEnv: (request) => ipcRenderer.invoke(IPC.projectEnvSubmit, request) as Promise<CallOutcome>,
    mcpServer: (request) => ipcRenderer.invoke(IPC.mcpServerSubmit, request) as Promise<CallOutcome>,
  },
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<OpenOutcome>,
  hub: {
    subscribe: (listener) => {
      listeners.add(listener);
      // Every subscriber starts from a state and (when live) a fresh snapshot; earlier ones just see a resync.
      void ipcRenderer.invoke(IPC.hubSubscribe);
      return () => {
        if (listeners.delete(listener) && listeners.size === 0) void ipcRenderer.invoke(IPC.hubUnsubscribe);
      };
    },
    call: (tool, input, options) =>
      ipcRenderer.invoke(IPC.hubCall, { tool, input, ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }) as Promise<CallOutcome>,
    chat: (project) => ipcRenderer.invoke(IPC.hubChat, project) as Promise<void>,
    focus: (workstreamId) => ipcRenderer.invoke(IPC.hubFocus, workstreamId) as Promise<void>,
    watch: (session) => ipcRenderer.invoke(IPC.hubWatch, session) as Promise<void>,
    input: (session, input) => ipcRenderer.invoke(IPC.hubInput, session, input) as Promise<void>,
    resync: () => ipcRenderer.invoke(IPC.hubResync) as Promise<void>,
    retryNow: () => ipcRenderer.invoke(IPC.hubRetryNow) as Promise<void>,
    cache: {
      read: () => ipcRenderer.invoke(IPC.hubCacheRead) as Promise<string | null>,
      write: (text) => ipcRenderer.invoke(IPC.hubCacheWrite, text) as Promise<void>,
    },
    connect: (url, key) => ipcRenderer.invoke(IPC.hubConnect, { url, key }) as Promise<ConnectOutcome>,
    forget: () => ipcRenderer.invoke(IPC.hubForget) as Promise<void>,
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
