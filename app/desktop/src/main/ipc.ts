import { clipboard, ipcMain, Menu, shell, type IpcMainInvokeEvent } from "electron";
import { IPC, type InvokeChannel } from "../shared/channels";
import { parseRequest, type RequestArgs } from "../shared/ipc";
import type { OpenOutcome } from "../shared/hub";
import { externalUrl } from "./external";
import type { HubService } from "./hub/service";
import { applyMenuState } from "./menuState";
import type { Notifier } from "./notify";
import type { Opener } from "./opener";
import { hostName, pickFolder, readDrop } from "./projects";
import { isOwnPage } from "./security";

/** Only our own top-level page may call main: not a subframe, not a local file, not a page navigated elsewhere. */
const trustedSender = (event: IpcMainInvokeEvent): boolean => {
  const frame = event.senderFrame;
  return frame !== null && frame === event.sender.mainFrame && isOwnPage(frame.url);
};

const handle = <C extends InvokeChannel>(
  channel: C,
  handler: (event: IpcMainInvokeEvent, ...args: RequestArgs<C>) => unknown,
): void => {
  ipcMain.handle(channel, (event, ...raw: Array<unknown>) => {
    if (!trustedSender(event)) throw new Error(`${channel}: refused, not the app's own page.`);
    const parsed = parseRequest(channel, raw);
    if (!parsed.ok) throw new Error(`${channel}: invalid request. ${parsed.reason}`);
    return handler(event, ...parsed.args);
  });
};

export const registerIpc = (hub: HubService, frame: { opener: Opener; notifier: Notifier }): void => {
  handle(IPC.hubState, () => hub.state());
  handle(IPC.hubSubscribe, (event) => hub.subscribe(event.sender));
  handle(IPC.hubUnsubscribe, (event) => hub.unsubscribe(event.sender));
  handle(IPC.hubCall, (_event, request) => hub.call(request));
  handle(IPC.hubLive, (_event, scope) => hub.live(scope));
  handle(IPC.hubResync, () => hub.resync());
  handle(IPC.hubConnect, (_event, request) => hub.connect(request));
  handle(IPC.hubForget, () => hub.forget());
  handle(IPC.systemHostName, () => hostName());
  handle(IPC.projectsPickFolder, (event) => pickFolder(event.sender));
  handle(IPC.projectsReadDrop, (_event, path) => readDrop(path));
  handle(IPC.copy, (_event, text) => clipboard.writeText(text));
  handle(IPC.openExternal, async (_event, url): Promise<OpenOutcome> => {
    const checked = externalUrl(url);
    if (!checked.ok) return checked;
    try {
      await shell.openExternal(checked.url);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: `The browser didn't open: ${String(error)}` };
    }
  });
  handle(IPC.appReady, () => frame.opener.ready());
  handle(IPC.appNotify, (_event, request) => frame.notifier.show(request));
  handle(IPC.appMenuState, (_event, enabled) => applyMenuState(Menu.getApplicationMenu(), enabled));
};
