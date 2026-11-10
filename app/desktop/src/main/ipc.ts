import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell, systemPreferences, type IpcMainInvokeEvent } from "electron";
import { IPC, type InvokeChannel } from "../shared/channels";
import type { AppLog } from "./applog";
import { artifactFrames } from "./artifactFrames";
import { parseRequest, type CallRequest, type RequestArgs } from "../shared/ipc";
import type { BrowserInput } from "../shared/contracts";
import type { OpenOutcome } from "../shared/hub";
import { externalUrl } from "./external";
import type { Hubs } from "./hub/hubs";
import { claimLinkHandler, linkHandlerStatus } from "./linkHandlerMain";
import type { PairingService } from "./pairing/service";
import type { PresenceSetting } from "./presence";
import { cancelGithubApp, createGithubApp } from "./github";
import { cancelGithubConnect, connectGithub } from "./githubConnect";
import { submitClaudeAccount, submitHubLink, submitMcpOauthClient, submitMcpServer, submitOnePassword, submitProjectEnv, submitSecret, submitCloudKey } from "./secret";
import { applyMenuState } from "./menuState";
import { authorizer, copyVaultField, revealVaultItem, saveVaultItem, unlockVault } from "./vault";
import type { Notifier } from "./notify";
import type { Opener } from "./opener";
import { hostName, pickFolder, readDrop } from "./projects";
import { copyImage, downloadFile, openFile, saveFile, showDownloaded } from "./files";
import { RELEASE_BUILD } from "./build";
import { fixtureRequest } from "./hub/fixture";
import { fleetdDir, joinHere, machineFingerprint, realPorts, thisComputer } from "./joinHere";
import type { JoinHere } from "../shared/joinHere";
import { hubOrigin, MacSetup, realMacPorts, signedInPorts } from "./macSetup";
import type { MenuBar } from "./menuBar";
import { fixtureMacPorts } from "./macSetupFixture";
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
  frame: {
    opener: Opener;
    notifier: Notifier;
    log: AppLog;
    updates: Updates;
    presence: PresenceSetting;
    sessionWindows: SessionWindows;
    /** Set up this Mac for agents' own window. */
    macSetupWindow: { show(): void };
    /** The agents' Mac's menu bar icon and its popover. */
    menuBar: Pick<MenuBar, "look" | "fit" | "hide" | "showMenu">;
  },
  pairing: PairingService,
): MacSetup => {
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
  handle(IPC.hubThumbs, (event, id, on) => hubs.get(id)?.thumbs(event.sender, on));
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
  handle(IPC.mcpOauthClientSubmit, (_event, id, request) => submitMcpOauthClient(request, call(id)));
  handle(IPC.githubAppCreate, (_event, id, request) =>
    createGithubApp(request, call(id), async (url) => {
      const checked = externalUrl(url);
      if (!checked.ok) throw new Error(checked.message);
      await shell.openExternal(checked.url);
    }),
  );
  handle(IPC.githubAppCancel, () => {
    cancelGithubApp();
    cancelGithubConnect();
  });
  handle(IPC.githubConnect, (_event, id) =>
    connectGithub(call(id), async (url) => {
      const checked = externalUrl(url);
      if (!checked.ok) throw new Error(checked.message);
      await shell.openExternal(checked.url);
    }),
  );
  handle(IPC.claudeAccountSubmit, (_event, id, request) => submitClaudeAccount(request, call(id)));
  handle(IPC.onePasswordSubmit, (_event, id, request) => submitOnePassword(request, call(id)));
  handle(IPC.cloudKeySubmit, (_event, id, request) => submitCloudKey(request, call(id)));
  // A vault value is shown or copied only once the person proves they're here: Touch ID where this Mac has it, else a
  // native confirm, which the page can't answer for them.
  const vaultAuthorize = authorizer({
    now: () => Date.now(),
    authorize: async (what) => {
      if (process.platform === "darwin" && systemPreferences.canPromptTouchID()) {
        return systemPreferences.promptTouchID(what).then(
          () => true,
          () => false,
        );
      }
      const verb = what.split(" ")[0] ?? "show";
      const options = {
        type: "question" as const,
        buttons: [verb.charAt(0).toUpperCase() + verb.slice(1), "Cancel"],
        defaultId: 0,
        cancelId: 1,
        message: `${what.charAt(0).toUpperCase()}${what.slice(1)}?`,
        detail: "It's shown for 30 seconds, and a copy leaves the clipboard after a minute. Every reveal is in the vault's activity.",
      };
      const win = BrowserWindow.getFocusedWindow();
      const answer = win === null ? await dialog.showMessageBox(options) : await dialog.showMessageBox(win, options);
      return answer.response === 0;
    },
  });
  handle(IPC.vaultSave, (_event, id, request) => saveVaultItem(request, call(id)));
  handle(IPC.vaultReveal, (_event, id, request) => revealVaultItem(request, call(id), vaultAuthorize, id));
  handle(IPC.vaultCopy, (_event, id, request) =>
    copyVaultField(request, call(id), vaultAuthorize, id, {
      readClipboard: () => clipboard.readText(),
      writeClipboard: (text) => clipboard.writeText(text),
      later: (fn, ms) => void setTimeout(fn, ms).unref(),
    }),
  );
  handle(IPC.vaultUnlock, (_event, id, request) => unlockVault(request, call(id)));
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
  // Set up this Mac for agents: one at a time, as there is one fleetd dir here. Its pane URLs are main's constants.
  // Under a fixture, a Mac that isn't there (macSetupFixture.ts).
  const macSetup = new MacSetup(
    fixtureRequest(process.env, RELEASE_BUILD).kind === "fixture"
      ? fixtureMacPorts()
      : // It trades its code over plain HTTP, as the Mac holds no key of its own. Only a hub admin's Update uses a key:
        // that of a hub this app is signed in to here (signedInPorts).
        realMacPorts(realPorts(() => Promise.resolve(gone)), {
          knownHubs: () => hubs.list().flatMap((h) => hubs.get(h.id)?.url() ?? []),
          openPane: (url) => shell.openExternal(url),
          // Only a hub this app is signed in to here: an admin's key updates it from the setup window.
          ...signedInPorts(() => hubs.list().flatMap((h) => {
            const url = hubs.get(h.id)?.url();
            return url === null || url === undefined ? [] : [{ url, call: call(h.id) }];
          })),
        }),
    (join) => {
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(IPC.macSetupJoinChanged, join);
      // Joined: the menu bar's icon comes now.
      if (join.state === "done") void frame.menuBar.look();
    },
  );
  /** The hub this app is signed in to at the Mac's hub's address; under a fixture, the fixture's. */
  const hubIdFor = (hubUrl: string): string | null => {
    if (fixtureRequest(process.env, RELEASE_BUILD).kind === "fixture") return hubs.list()[0]?.id ?? null;
    const origin = hubOrigin(hubUrl);
    return hubs.list().find((h) => {
      const url = hubs.get(h.id)?.url();
      return url !== null && url !== undefined && hubOrigin(url) === origin;
    })?.id ?? null;
  };
  handle(IPC.macSetupOpen, () => {
    if (process.platform === "darwin") frame.macSetupWindow.show();
  });
  handle(IPC.macSetupRedeem, (_event, request) => macSetup.redeem(request));
  handle(IPC.macSetupJoin, () => macSetup.join());
  handle(IPC.macSetupHealth, (_event, hub) => macSetup.health(hub ?? undefined));
  handle(IPC.macSetupPane, (_event, pane) => macSetup.openPane(pane));
  handle(IPC.macSetupRestart, () => macSetup.restart());
  handle(IPC.macSetupStatus, () => macSetup.status());
  handle(IPC.macSetupCancel, () => macSetup.cancel());
  handle(IPC.macSetupUpdateHub, (_event, hub) => macSetup.updateHub(hub));
  handle(IPC.menuBarRead, () => macSetup.menuBar(hubIdFor));
  handle(IPC.menuBarFit, (_event, height) => frame.menuBar.fit(height));
  handle(IPC.menuBarHide, () => frame.menuBar.hide());
  handle(IPC.menuBarMenu, () => frame.menuBar.showMenu());
  handle(IPC.projectsPickFolder, (event) => pickFolder(event.sender));
  handle(IPC.projectsReadDrop, (_event, path) => readDrop(path));
  handle(IPC.copy, (_event, text) => clipboard.writeText(text));
  handle(IPC.artifactFrame, (_event, html) => artifactFrames.put(html));
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
  handle(IPC.fileOpen, (_event, id, request) => openFile(call(id), request));
  handle(IPC.fileSave, (event, id, request) => saveFile(call(id), request, event.sender));
  handle(IPC.fileDownload, (_event, id, request) => downloadFile(call(id), request));
  handle(IPC.fileShow, (_event, path) => showDownloaded(path));
  handle(IPC.fileCopyImage, (_event, id, request) => copyImage(call(id), request));
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
  return macSetup;
};
