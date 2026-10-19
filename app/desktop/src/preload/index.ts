import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { OpenTarget } from "../shared/app";
import { IPC } from "../shared/channels";
import type { CallOutcome, ConnectOutcome, HubFrame, HubState } from "../shared/hub";
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

const api: FleetdApi = {
  platform: process.platform === "darwin" || process.platform === "linux" || process.platform === "win32" ? process.platform : "other",
  copy: (text) => ipcRenderer.invoke(IPC.copy, text) as Promise<void>,
  hub: {
    state: () => ipcRenderer.invoke(IPC.hubState) as Promise<HubState>,
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
    live: (scope) => ipcRenderer.invoke(IPC.hubLive, scope) as Promise<void>,
    resync: () => ipcRenderer.invoke(IPC.hubResync) as Promise<void>,
    connect: (url, key) => ipcRenderer.invoke(IPC.hubConnect, { url, key }) as Promise<ConnectOutcome>,
    forget: () => ipcRenderer.invoke(IPC.hubForget) as Promise<void>,
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
    notify: (request) => ipcRenderer.invoke(IPC.appNotify, request) as Promise<void>,
    setMenuState: (enabled) => ipcRenderer.invoke(IPC.appMenuState, enabled) as Promise<void>,
  },
};

contextBridge.exposeInMainWorld("fleetd", api);
