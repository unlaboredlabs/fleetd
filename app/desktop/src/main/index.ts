// Before anything else: a release build refuses debugging switches before Chromium can act on them.
import "./debug-guard";
import { existsSync } from "node:fs";
import { homedir, release } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { app, BrowserWindow, clipboard, crashReporter, dialog, Menu, nativeTheme, net, powerMonitor, screen, session, shell, Tray } from "electron";
import { asError } from "../shared/scrub";
import { AppLog, diagnostics } from "./applog";
import { RELEASE_BUILD } from "./build";
import { fixtureRequest, loadFixture } from "./hub/fixture";
import { fromEnv } from "./hub/credentials";
import { osCredentialEnv } from "./hub/os";
import type { KeyStore } from "../shared/pairing";
import { Hubs, type HubsMode } from "./hub/hubs";
import { webSocketTransport } from "./hub/transport";
import { instrument } from "./instrument";
import { timedTransport } from "./instrument/perf";
import { registerIpc } from "./ipc";
import { realCloud, type Cloud } from "./cloud";
import { builtCloudConfig } from "./cloud/config";
import { FixtureCloud, readCloudSection } from "./cloud/fixture";
import { externalUrl } from "./external";
import { fixturePairingDeps } from "./pairing/fixture";
import { PairingService, realPairingDeps } from "./pairing/service";
import { editMenuTemplate } from "./editMenu";
import { installMenu } from "./menu";
import type { MacSetup } from "./macSetup";
import { MenuBar, menuTemplate, POPOVER_WIDTH } from "./menuBar";
import { trayIcon } from "./trayIcon";
import { Notifier } from "./notify";
import { watchWake } from "./online";
import { claimOnFirstRun } from "./linkHandlerMain";
import { listenForLinks } from "./links";
import { Opener } from "./opener";
import { PresenceSetting, startPresence } from "./presence";
import { FAILURES_IN_A_ROW, guardWindow } from "./recovery";
import { harden, isOwnPage, lockSession, pageUrl } from "./security";
import { updates } from "./updater";
import { SessionWindows } from "./sessionWindow";
import { restorePlacement, trackPlacement } from "./windowState";
import { TRAFFIC_LIGHTS } from "../shared/frame";


// Below 1000 px wide the sidebar hides itself (renderer/screens/shell/Shell.tsx), so a 900 px window still gives the
// chat its full width.
const LIMITS = { width: 1400, height: 900, minWidth: 900, minHeight: 600 };

/**
 * The fleetd dir, shared with the CLI (app-pair.json) and the GPUI app (hub.json): `<appData>/fleetd`, i.e.
 * ~/Library/Application Support/fleetd or $XDG_CONFIG_HOME/fleetd. FLEETD_HOME moves it, for tests and the QA harness.
 */
const fleetdHome = process.env["FLEETD_HOME"];
const FLEETD_DIR = fleetdHome !== undefined && isAbsolute(fleetdHome) ? fleetdHome : join(app.getPath("appData"), "fleetd");
// Chromium's own state (caches, local storage) stays in a subdirectory, unless the caller chose one.
if (!app.commandLine.hasSwitch("user-data-dir")) app.setPath("userData", join(FLEETD_DIR, "desktop"));

// The app log and crash dumps: the OS log directory (macOS ~/Library/Logs/fleetd; Linux $XDG_STATE_HOME/fleetd, by
// default ~/.local/state/fleetd), or FLEETD_HOME/logs, so a test run never writes to the real one.
const xdgState = process.env["XDG_STATE_HOME"];
app.setAppLogsPath(
  fleetdHome !== undefined && isAbsolute(fleetdHome)
    ? join(fleetdHome, "logs")
    : process.platform === "linux"
      ? join(xdgState !== undefined && isAbsolute(xdgState) ? xdgState : join(homedir(), ".local", "state"), "fleetd")
      : undefined,
);
const appLog = new AppLog(join(app.getPath("logs"), "app.log"), { version: app.getVersion(), home: homedir() });
// A crash leaves a minidump beside the log; nothing is uploaded.
app.setPath("crashDumps", join(app.getPath("logs"), "crashes"));
crashReporter.start({ uploadToServer: false });
process.on("uncaughtException", (error) => {
  appLog.write({ source: "main", what: "Uncaught exception in main", error: asError(error) });
  console.error(error);
});
process.on("unhandledRejection", (reason) => {
  appLog.write({ source: "main", what: "Unhandled rejection in main", error: asError(reason) });
  console.error(reason);
});
let quitting = false;
app.on("before-quit", () => {
  quitting = true;
});
/** Set once the hub service exists, for Copy Diagnostics. */
let hubService: Hubs | null = null;
const diagnosticsText = (): string =>
  diagnostics({
    version: app.getVersion(),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome },
    os: `${process.platform} ${release()} ${process.arch}`,
    hubs: hubService?.all().map((h) => h.state()) ?? [{ phase: "unpaired" }],
    log: appLog,
  });
const help = {
  revealLogs: () => {
    if (existsSync(appLog.file)) shell.showItemInFolder(appLog.file);
    else void shell.openPath(dirname(appLog.file));
  },
  copyDiagnostics: () => void clipboard.writeText(diagnosticsText()),
};

// Idle memory (perf/budgets.ts): the network service runs in this process, not a utility process of its own. Pages
// load only app:// and the hub socket is Node's, so it carries next to nothing.
app.commandLine.appendSwitch("enable-features", "NetworkServiceInProcess2");
harden();
const opener = new Opener();
// A second launch hands its fleetd:// link to the running instance and quits before opening anything. The lock is
// per userData directory, so this comes after it is set (and parallel QA runs, each with its own, don't collide).
const primary = listenForLinks(opener);
if (!primary) app.quit();

const fixtureDir = (): string => process.env["FLEETD_FIXTURE_DIR"] ?? join(app.getAppPath(), "fixtures");
/** The same resolution as loadFixture: a name in the fixture dir, or an absolute path. */
const fixtureFile = (name: string): string => (isAbsolute(name) ? name : join(fixtureDir(), `${name}.json`));

/** The hub, or a fixture standing in for it; `fixtureFile` is also where pairing finds the fixture's `pair` section. */
const hubMode = (): { mode: HubsMode; fixtureFile: string | null; keyStore: KeyStore } => {
  const request = fixtureRequest(process.env, RELEASE_BUILD);
  if (request.kind === "ignored") console.warn(request.reason);
  if (request.kind !== "fixture") {
    const credentials = osCredentialEnv(FLEETD_DIR, fleetdHome !== undefined);
    return {
      mode: {
        kind: "hub",
        dir: FLEETD_DIR,
        credentials,
        vars: process.env,
        transport: process.env["FLEETD_PERF"] === undefined ? webSocketTransport : timedTransport(webSocketTransport),
        cacheDir: app.getPath("userData"),
      },
      fixtureFile: null,
      keyStore: fromEnv(process.env) === null ? credentials.store : { kind: "env" },
    };
  }
  return {
    mode: { kind: "fixture", fixture: loadFixture(request.name, fixtureDir()), cloud: readCloudSection(fixtureFile(request.name))?.hub === true },
    fixtureFile: fixtureFile(request.name),
    keyStore: { kind: "os", where: "the OS keychain" },
  };
};

/** What every window of the app's page runs with: the preload, the sandbox and what the page reads at startup. */
const pagePreferences = (mode: HubsMode) => {
  const mac = process.platform === "darwin";
  return {
    preload: join(import.meta.dirname, "../preload/index.cjs"),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
    additionalArguments: [
      // The version, for an error card's Copy details.
      `--fleetd-version=${app.getVersion()}`,
      // The page shows a "sample data" banner for as long as a fixture stands in for the hub.
      ...(mode.kind === "fixture" ? [`--fleetd-fixture=${mode.fixture.name}`] : []),
      // The hubs as the window opens, so the page renders at once rather than after a round trip; it asks again after.
      `--fleetd-hubs=${encodeURIComponent(JSON.stringify(hubService?.list() ?? []))}`,
      ...(mac ? ["--fleetd-vibrancy"] : []),
      // Chromium composites without a GPU (a VM, a remote desktop, a Linux driver it won't use, CI): the page's glass
      // goes solid, as with Reduce transparency, since each frame would blur on the CPU.
      ...(app.getGPUFeatureStatus().gpu_compositing.startsWith("enabled") ? [] : ["--fleetd-software-compositing"]),
    ],
  };
};

const createWindow = (mode: HubsMode): BrowserWindow => {
  const mac = process.platform === "darwin";
  const placement = restorePlacement(LIMITS);
  const win = new BrowserWindow({
    ...placement.bounds,
    minWidth: LIMITS.minWidth,
    minHeight: LIMITS.minHeight,
    show: false,
    title: "fleetd",
    // Painted before the page is, so a dark system never flashes white. On macOS the window's own material shows
    // instead: the page paints everything but the sidebar, which stays clear over it.
    backgroundColor: mac ? "#00000000" : nativeTheme.shouldUseDarkColors ? "#111214" : "#ffffff",
    ...(mac
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: TRAFFIC_LIGHTS,
          // The translucent sidebar: an NSVisualEffectView the window server composites behind the page. It is
          // static (nothing in the page repaints for it) and goes opaque on its own with Reduce transparency.
          vibrancy: "sidebar" as const,
          visualEffectState: "followWindow" as const,
        }
      : {}),
    webPreferences: pagePreferences(mode),
  });
  win.once("ready-to-show", () => {
    if (placement.maximized) win.maximize();
    if (placement.fullScreen) win.setFullScreen(true);
    win.show();
  });
  // With no window the page can't keep the count current; a stale one would lie.
  win.once("closed", () => app.setBadgeCount(0));
  trackPlacement(win);
  guardWindow(win, {
    log: appLog,
    load: (url) => void win.loadURL(url ?? pageUrl()),
    ask: () =>
      dialog
        .showMessageBox(win, {
          type: "error",
          message: "fleetd’s window keeps failing",
          detail: `It failed ${String(FAILURES_IN_A_ROW)} times in a row. Reload to try again, or copy the diagnostics for a bug report.`,
          buttons: ["Reload", "Copy Diagnostics", "Quit"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
        .then((r) => r.response),
    copyDiagnostics: help.copyDiagnostics,
    quit: () => app.quit(),
    quitting: () => quitting,
    isOwnPage,
  });
  win.webContents.on("context-menu", (_event, params) => {
    const template = editMenuTemplate(params);
    if (template !== null) Menu.buildFromTemplate(template).popup({ window: win });
  });
  opener.attach(win);
  instrument(win);
  void win.loadURL(pageUrl());
  return win;
};

void app.whenReady().then(() => {
  if (!primary) return;
  lockSession(join(import.meta.dirname, "../renderer"));
  // Every window has spellcheck off; this keeps the session from setting up (and fetching) dictionaries anyway.
  session.defaultSession.setSpellCheckerEnabled(false);
  let mode: HubsMode;
  let pairing: PairingService;
  let cloud: Cloud;
  let hub: Hubs;
  let fixtureFile: string | null;
  try {
    const chosen = hubMode();
    fixtureFile = chosen.fixtureFile;
    mode = chosen.mode;
    const service = new Hubs(mode);
    hub = service;
    hubService = service;
    const connect: Parameters<typeof realPairingDeps>[1] = (url, key, target) => service.connect({ url, key }, target);
    const firstRun = () => service.firstRun();
    pairing = new PairingService(
      chosen.fixtureFile === null
        ? realPairingDeps(FLEETD_DIR, connect, firstRun, chosen.keyStore)
        : fixturePairingDeps(chosen.fixtureFile, connect, firstRun),
    );
    cloud =
      chosen.fixtureFile === null
        ? realCloud(builtCloudConfig(), service, FLEETD_DIR, !RELEASE_BUILD, async (url) => {
            const checked = externalUrl(url);
            if (!checked.ok) throw new Error(checked.message);
            await shell.openExternal(checked.url);
          })
        : new FixtureCloud(readCloudSection(chosen.fixtureFile));
  } catch (error) {
    appLog.write({ source: "main", what: "fleetd couldn't start", error: asError(error) });
    console.error(error instanceof Error ? error.message : error);
    app.exit(2);
    return;
  }
  const updater = updates(fixtureFile);
  const presence = new PresenceSetting(join(app.getPath("userData"), "presence.json"));
  const sessionWindows = new SessionWindows((hash) => {
    const win = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 720,
      minHeight: 520,
      show: false,
      title: "Screen · fleetd",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#111214" : "#ffffff",
      ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: TRAFFIC_LIGHTS } : {}),
      webPreferences: pagePreferences(mode),
    });
    win.once("ready-to-show", () => win.show());
    void win.loadURL(`${pageUrl()}${hash}`);
    return win;
  });
  // Set up this Mac for agents: a small window of its own on the page's `#/mac-setup`, never the full interface.
  let macWindow: BrowserWindow | undefined;
  const macSetupWindow = {
    show: () => {
      if (macWindow !== undefined && !macWindow.isDestroyed()) {
        if (macWindow.isMinimized()) macWindow.restore();
        macWindow.focus();
        return;
      }
      const win = new BrowserWindow({
        width: 560,
        height: 680,
        minWidth: 480,
        minHeight: 560,
        show: false,
        title: "Set up this Mac for agents",
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#111214" : "#ffffff",
        titleBarStyle: "hiddenInset" as const,
        trafficLightPosition: TRAFFIC_LIGHTS,
        webPreferences: pagePreferences(mode),
      });
      win.once("ready-to-show", () => win.show());
      win.once("closed", () => {
        if (macWindow === win) macWindow = undefined;
      });
      void win.loadURL(`${pageUrl()}#/mac-setup`);
      macWindow = win;
    },
  };
  // The agents' Mac's menu bar: an icon once this Mac is joined as the agents' Mac, on macOS; under a fixture with
  // FLEETD_FIXTURE_MAC, on any computer, for QA (macSetupFixture.ts).
  // Set once registerIpc made it, below; the icon looks only after that.
  const macSetup: { current?: MacSetup } = {};
  const dark = () => nativeTheme.shouldUseDarkColors;
  const menuBar = new MenuBar({
    joined: async () => (await macSetup.current?.status())?.kind === "joined",
    tray: () => new Tray(trayIcon()),
    popover: () => {
      const mac = process.platform === "darwin";
      const win = new BrowserWindow({
        width: POPOVER_WIDTH,
        height: 420,
        show: false,
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        title: "fleetd",
        // On macOS a menu's own material, which the page leaves clear; elsewhere the theme's surface.
        backgroundColor: mac ? "#00000000" : dark() ? "#1c1c1f" : "#ffffff",
        ...(mac ? { type: "panel" as const, vibrancy: "menu" as const, visualEffectState: "active" as const, roundedCorners: true } : {}),
        webPreferences: pagePreferences(mode),
      });
      if (mac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      void win.loadURL(`${pageUrl()}#/menubar`);
      return win;
    },
    area: (at) => screen.getDisplayNearestPoint(at).workArea,
    menu: (items) => Menu.buildFromTemplate(menuTemplate(items)),
    openApp: () => void opener.focus(),
    quit: () => app.quit(),
    openAtLogin: () => app.getLoginItemSettings().openAtLogin,
    // Never under a fixture: QA leaves the machine it runs on as it was.
    setOpenAtLogin: (on) => {
      if (mode.kind !== "fixture") app.setLoginItemSettings({ openAtLogin: on });
    },
    marker: join(app.getPath("userData"), "menu-bar-login"),
  });
  macSetup.current = registerIpc(hub, { opener, notifier: new Notifier(opener), log: appLog, updates: updater, presence, sessionWindows, macSetupWindow, menuBar }, pairing, cloud);
  if (process.platform === "darwin" || (mode.kind === "fixture" && process.env["FLEETD_FIXTURE_MAC"] !== undefined)) menuBar.start();
  // QA opens the popover at once, under a fixture only: it has no menu bar to click.
  if (mode.kind === "fixture" && process.env["FLEETD_FIXTURE_MAC_OPEN"] === "1") void menuBar.look().then(() => menuBar.show({ pinned: true }));
  installMenu(opener, help, process.platform === "darwin" ? macSetupWindow.show : undefined);
  claimOnFirstRun();
  // The hubs' live feeds only fill what windows show: paused while every window is hidden or minimized (or, on macOS,
  // closed with the app still running), and asked for again, in full, once one is about to show.
  const windowsShown = () => hub.windowsShown(BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized()));
  app.on("browser-window-created", (_event, win) => {
    hub.windowsShown(true);
    win.on("show", windowsShown).on("hide", windowsShown).on("minimize", windowsShown).on("restore", windowsShown).on("closed", windowsShown);
  });
  app.on("browser-window-focus", () => {
    hub.windowsShown(true);
    hub.windowFocused();
    updater.focused();
  });
  const stopOnline = watchWake(powerMonitor, () => net.isOnline(), () => hub.systemResumed());
  const stopPresence = startPresence({
    on: () => presence.on,
    focused: () => BrowserWindow.getFocusedWindow() !== null,
    active: (seconds) => powerMonitor.getSystemIdleState(seconds) === "active",
    // Each hub hears its own project on screen, if any (Hubs.presence).
    project: () => null,
    send: (frame) => hub.presence(frame),
  });
  app.on("will-quit", () => {
    stopPresence();
    stopOnline();
    hub.stop();
  });
  opener.setHooks({
    create: () => void createWindow(mode),
    activateApp: () => {
      if (process.platform === "darwin") app.focus({ steal: true });
    },
  });
  // The hubs dial once the window shows (or after 3 s, should it never say so): the page and its cached data paint
  // first, and the connection's start (the OS's CAs, the sockets) is off the way to the window.
  const first = createWindow(mode);
  const dial = setTimeout(() => hub.start(), 3_000);
  first.once("ready-to-show", () => {
    clearTimeout(dial);
    hub.start();
  });
  updater.start();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(mode);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
