import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, shell, type IpcMainInvokeEvent } from "electron";
import { IPC, type InvokeChannel } from "../shared/channels";
import type { AppLog } from "./applog";
import { parseRequest, type CallRequest, type RequestArgs } from "../shared/ipc";
import type { BrowserInput } from "../shared/contracts";
import type { OpenOutcome } from "../shared/hub";
import { externalUrl } from "./external";
import type { Hubs } from "./hub/hubs";
import { claimLinkHandler, linkHandlerStatus } from "./linkHandlerMain";
import type { PairingService } from "./pairing/service";
import type { PresenceSetting } from "./presence";
import { cancelGoogle, connectGoogle } from "./google";
import { submitClaudeAccount, submitGoogleClient, submitGooglePubsub, submitHubLink, submitMcpServer, submitProjectEnv, submitSecret } from "./secret";
import { applyMenuState } from "./menuState";
import type { Notifier } from "./notify";
import type { Opener } from "./opener";
import { hostName, pickFolder, readDrop } from "./projects";
import { RELEASE_BUILD } from "./build";
import { fixtureRequest } from "./hub/fixture";
import { fleetdDir, joinHere, machineFingerprint, realPorts, thisComputer } from "./joinHere";
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
  hubs: Hubs,
  frame: { opener: Opener; notifier: Notifier; log: AppLog; updates: Updates; presence: PresenceSetting; sessionWindows: SessionWindows },
  pairing: PairingService,
): void => {
  // A hub removed while a call was on its way answers as an unpaired one would.
  const gone = { ok: false, error: { code: "offline", message: "That hub was removed from this app." } } as const;
  const call = (id: string) => (tool: string, input: unknown) => hubs.get(id)?.call({ tool, input: input as CallRequest["input"] }) ?? Promise.resolve(gone);
  handle(IPC.hubsList, () => hubs.list());
  handle(IPC.hubsUpdate, (_event, id, change) => hubs.update(id, change));
  hubs.onChange((list) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(IPC.hubsChanged, list);
  });
  handle(IPC.hubSubscribe, (event, id) => hubs.get(id)?.subscribe(event.sender));
  handle(IPC.hubUnsubscribe, (event, id) => hubs.get(id)?.unsubscribe(event.sender));
  handle(IPC.hubCall, (_event, id, request) => hubs.get(id)?.call(request) ?? gone);
  handle(IPC.hubChat, (_event, id, project) => hubs.get(id)?.chat(project));
  handle(IPC.hubFocus, (_event, id, workstreamId) => hubs.get(id)?.focus(workstreamId));
  handle(IPC.hubWatch, (event, id, session) => hubs.get(id)?.watch(event.sender, session));
  // Checked against the contract's shape above; an absent field may arrive as undefined, which JSON leaves out.
  handle(IPC.hubInput, (_event, id, session, input) => hubs.get(id)?.input(session, input as BrowserInput));
  handle(IPC.hubResync, (_event, id) => hubs.get(id)?.resync());
  handle(IPC.hubRetryNow, (_event, id) => hubs.get(id)?.retryNow());
  handle(IPC.hubCacheRead, (_event, id) => hubs.get(id)?.cacheRead() ?? null);
  handle(IPC.hubCacheWrite, (_event, id, text) => hubs.get(id)?.cacheWrite(text));
  handle(IPC.hubConnect, (_event, { target, ...request }) => hubs.connect(request, target));
  handle(IPC.hubForget, (_event, id) => hubs.remove(id));
  handle(IPC.secretSubmit, (_event, id, request) => submitSecret(request, call(id)));
  handle(IPC.projectEnvSubmit, (_event, id, request) => submitProjectEnv(request, call(id)));
  handle(IPC.mcpServerSubmit, (_event, id, request) => submitMcpServer(request, call(id)));
  handle(IPC.hubLinkSubmit, (_event, id, request) => submitHubLink(request, call(id)));
  handle(IPC.googleClientSubmit, (_event, id, request) => submitGoogleClient(request, call(id)));
  handle(IPC.googlePubsubSubmit, (_event, id, request) => submitGooglePubsub(request, call(id)));
  handle(IPC.googleConnect, (_event, id, request) =>
    connectGoogle(request, call(id), async (url) => {
      const checked = externalUrl(url);
      if (!checked.ok) throw new Error(checked.message);
      await shell.openExternal(checked.url);
    }),
  );
  handle(IPC.googleCancel, () => cancelGoogle());
  handle(IPC.claudeAccountSubmit, (_event, id, request) => submitClaudeAccount(request, call(id)));
  handle(IPC.systemHostName, () => hostName());
  // This computer joins the hub the page's Add machine is on, and each hub keeps its own join's state. One join at a
  // time, as there is one fleetd dir here: asked again for the same hub while it runs, the page gets that one and
  // follows it on the push channel; asked for another hub, it is told to wait.
  let joining: { readonly hub: string; readonly run: Promise<JoinHere> } | undefined;
  const lastJoin = new Map<string, JoinHere>();
  const sendJoin = (id: string) => (state: JoinHere) => {
    lastJoin.set(id, state);
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(IPC.machinesJoinHereChanged, id, state);
  };
  handle(IPC.machinesJoinHere, (_event, id, machineId): Promise<JoinHere> => {
    if (joining !== undefined && joining.hub !== id) {
      const other = hubs.list().find((h) => h.id === joining?.hub)?.label ?? "another hub";
      return Promise.resolve({ machineId, state: "failed", steps: [], message: `This computer is joining ${other} now; try again once that is done.` });
    }
    if (joining === undefined) {
      const run = joinHere(realPorts(call(id)), machineId, sendJoin(id)).finally(() => {
        joining = undefined;
      });
      joining = { hub: id, run };
    }
    return joining.run;
  });
  handle(IPC.machinesJoinHereState, (_event, id) => lastJoin.get(id) ?? null);
  // Under a fixture, a computer that is neither, whatever this one holds.
  handle(IPC.machinesThisComputer, () => (fixtureRequest(process.env, RELEASE_BUILD).kind === "fixture" ? { kind: "none" } : machineFingerprint().then((fp) => thisComputer(fleetdDir(), fp))));
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
