// Before anything else: a release build refuses debugging switches before Chromium can act on them.
import "./debug-guard";
import { existsSync } from "node:fs";
import { homedir, release } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { app, BrowserWindow, clipboard, crashReporter, dialog, Menu, nativeTheme, powerMonitor, session, shell } from "electron";
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
import { registerIpc } from "./ipc";
import { fixturePairingDeps } from "./pairing/fixture";
import { PairingService, realPairingDeps } from "./pairing/service";
import { editMenuTemplate } from "./editMenu";
import { installMenu } from "./menu";
import { Notifier } from "./notify";
import { claimOnFirstRun } from "./linkHandlerMain";
import { listenForLinks } from "./links";
import { Opener } from "./opener";
import { PresenceSetting, startPresence } from "./presence";
import { FAILURES_IN_A_ROW, guardWindow } from "./recovery";
import { harden, isOwnPage, lockSession, pageUrl } from "./security";
import { updates } from "./updater";
import { SessionWindows } from "./sessionWindow";
import { restorePlacement, trackPlacement } from "./windowState";

/** Height of the renderer's top bar; the macOS traffic lights are centred in it. */
const TOP_BAR = 44;
const TRAFFIC_LIGHT = 16;

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
        transport: webSocketTransport,
        cacheDir: app.getPath("userData"),
      },
      fixtureFile: null,
      keyStore: fromEnv(process.env) === null ? credentials.store : { kind: "env" },
    };
  }
  return {
    mode: { kind: "fixture", fixture: loadFixture(request.name, fixtureDir()) },
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
          trafficLightPosition: { x: 16, y: (TOP_BAR - TRAFFIC_LIGHT) / 2 },
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
      ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: (TOP_BAR - TRAFFIC_LIGHT) / 2 } } : {}),
      webPreferences: pagePreferences(mode),
    });
    win.once("ready-to-show", () => win.show());
    void win.loadURL(`${pageUrl()}${hash}`);
    return win;
  });
  registerIpc(hub, { opener, notifier: new Notifier(opener), log: appLog, updates: updater, presence, sessionWindows }, pairing);
  installMenu(opener, help);
  claimOnFirstRun();
  app.on("browser-window-focus", () => {
    hub.windowFocused();
    updater.focused();
  });
  powerMonitor.on("resume", () => hub.systemResumed());
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
    hub.stop();
  });
  opener.setHooks({
    create: () => void createWindow(mode),
    activateApp: () => {
      if (process.platform === "darwin") app.focus({ steal: true });
    },
  });
  createWindow(mode);
  updater.start();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(mode);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
