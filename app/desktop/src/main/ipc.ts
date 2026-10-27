import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, shell, type IpcMainInvokeEvent } from "electron";
import { IPC, type InvokeChannel } from "../shared/channels";
import type { AppLog } from "./applog";
import { parseRequest, type RequestArgs } from "../shared/ipc";
import type { BrowserInput } from "../shared/contracts";
import type { OpenOutcome } from "../shared/hub";
import { externalUrl } from "./external";
import type { HubService } from "./hub/service";
import { claimLinkHandler, linkHandlerStatus } from "./linkHandlerMain";
import type { PairingService } from "./pairing/service";
import type { PresenceSetting } from "./presence";
import { submitMcpServer, submitProjectEnv, submitSecret } from "./secret";
import { applyMenuState } from "./menuState";
import type { Notifier } from "./notify";
import type { Opener } from "./opener";
import { hostName, pickFolder, readDrop } from "./projects";
import { RELEASE_BUILD } from "./build";
import { fixtureRequest } from "./hub/fixture";
import { fleetdDir, joinHere, realPorts, thisComputer } from "./joinHere";
import type { JoinHere } from "../shared/joinHere";
import { isOwnPage } from "./security";
import type { SessionWindows } from "./sessionWindow";
import type { Updates } from "./updater";

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

export const registerIpc = (
  hub: HubService,
  frame: { opener: Opener; notifier: Notifier; log: AppLog; updates: Updates; presence: PresenceSetting; sessionWindows: SessionWindows },
  pairing: PairingService,
): void => {
  handle(IPC.hubSubscribe, (event) => hub.subscribe(event.sender));
  handle(IPC.hubUnsubscribe, (event) => hub.unsubscribe(event.sender));
  handle(IPC.hubCall, (_event, request) => hub.call(request));
  handle(IPC.hubChat, (_event, project) => hub.chat(project));
  handle(IPC.hubFocus, (_event, workstreamId) => hub.focus(workstreamId));
  handle(IPC.hubWatch, (event, session) => hub.watch(event.sender, session));
  // Checked against the contract's shape above; an absent field may arrive as undefined, which JSON leaves out.
  handle(IPC.hubInput, (_event, session, input) => hub.input(session, input as BrowserInput));
  handle(IPC.hubResync, () => hub.resync());
  handle(IPC.hubRetryNow, () => hub.retryNow());
  handle(IPC.hubCacheRead, () => hub.cacheRead());
  handle(IPC.hubCacheWrite, (_event, text) => hub.cacheWrite(text));
  handle(IPC.hubConnect, (_event, request) => hub.connect(request));
  handle(IPC.hubForget, () => hub.forget());
  handle(IPC.secretSubmit, (_event, request) => submitSecret(request, (tool, input) => hub.call({ tool, input })));
  handle(IPC.projectEnvSubmit, (_event, request) => submitProjectEnv(request, (tool, input) => hub.call({ tool, input })));
  handle(IPC.mcpServerSubmit, (_event, request) => submitMcpServer(request, (tool, input) => hub.call({ tool, input })));
  handle(IPC.systemHostName, () => hostName());
  // One join at a time: the page asking again while one runs gets that one, and follows it on the push channel.
  let joining: Promise<JoinHere> | undefined;
  let lastJoin: JoinHere | null = null;
  const sendJoin = (state: JoinHere) => {
    lastJoin = state;
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(IPC.machinesJoinHereChanged, state);
  };
  handle(IPC.machinesJoinHere, (_event, machineId) => {
    joining ??= joinHere(realPorts((tool, input) => hub.call({ tool, input })), machineId, sendJoin).finally(() => {
      joining = undefined;
    });
    return joining;
  });
  handle(IPC.machinesJoinHereState, () => lastJoin);
  // Under a fixture, a computer that is neither, whatever this one holds.
  handle(IPC.machinesThisComputer, () => (fixtureRequest(process.env, RELEASE_BUILD).kind === "fixture" ? { kind: "none" } : thisComputer(fleetdDir())));
  handle(IPC.projectsPickFolder, (event) => pickFolder(event.sender));
  handle(IPC.projectsReadDrop, (_event, path) => readDrop(path));
  handle(IPC.copy, (_event, text) => clipboard.writeText(text));
  handle(IPC.pairStart, () => pairing.start());
  handle(IPC.pairProbe, (_event, address) => pairing.probe(address));
  handle(IPC.pairRedeem, (_event, request) => pairing.redeem(request));
  handle(IPC.pairAuto, () => pairing.auto());
  handle(IPC.pairStore, () => pairing.store());
  handle(IPC.pairSetup, () => pairing.setup());
  handle(IPC.appSessionWindow, (_event, request) => frame.sessionWindows.show(request));
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
  // macOS shows it on the Dock icon; Linux only where the launcher supports badges (Unity), and ignores it elsewhere.
  handle(IPC.appBadge, (_event, count) => void app.setBadgeCount(count));
  handle(IPC.appTheme, (_event, mode) => {
    nativeTheme.themeSource = mode;
  });
  handle(IPC.appLinkHandler, (_event, claim) => (claim === null ? linkHandlerStatus() : claimLinkHandler(claim)));
  handle(IPC.appPresence, (_event, on) => (on === null ? frame.presence.on : frame.presence.set(on)));
  handle(IPC.appMenuState, (_event, enabled) => applyMenuState(Menu.getApplicationMenu(), enabled));
  handle(IPC.appLog, (_event, { what, route, ...error }) => {
    frame.log.write({ source: "window", what, route, error });
  });
  handle(IPC.updatesState, () => frame.updates.state());
  handle(IPC.updatesCheck, () => frame.updates.check());
  handle(IPC.updatesInstall, () => frame.updates.install());
  handle(IPC.updatesKeep, () => frame.updates.keep());
  frame.updates.onChange((state) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(IPC.updatesChanged, state);
  });
};
