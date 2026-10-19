import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { IPC } from "../shared/channels";
import type { CallOutcome, ConnectOutcome, DropInfo, HubFrame, HubState } from "../shared/hub";
import type { FleetdApi } from "./api";

const listeners = new Set<(frame: HubFrame) => void>();

// One IPC listener for all subscribers; the IpcRendererEvent (which carries `sender`) never reaches the page.
ipcRenderer.on(IPC.hubFrame, (_event: IpcRendererEvent, frame: HubFrame) => {
  for (const listener of listeners) listener(frame);
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
};

contextBridge.exposeInMainWorld("fleetd", api);
