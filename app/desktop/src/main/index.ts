// Before anything else: a release build refuses debugging switches before Chromium can act on them.
import "./debug-guard";
import { isAbsolute, join } from "node:path";
import tls from "node:tls";
import { app, BrowserWindow, nativeTheme, powerMonitor } from "electron";
import { RELEASE_BUILD } from "./build";
import { fixtureRequest, loadFixture } from "./hub/fixture";
import { osCredentialEnv } from "./hub/os";
import { HubService, type HubMode } from "./hub/service";
import { webSocketTransport } from "./hub/transport";
import { registerIpc } from "./ipc";
import { installMenu } from "./menu";
import { Notifier } from "./notify";
import { claimOnFirstRun } from "./linkHandlerMain";
import { listenForLinks } from "./links";
import { Opener } from "./opener";
import { harden, lockSession, pageUrl } from "./security";
import { restorePlacement, trackPlacement } from "./windowState";

/** Height of the renderer's top bar; the macOS traffic lights are centred in it. */
const TOP_BAR = 44;
const TRAFFIC_LIGHT = 16;

const LIMITS = { width: 1400, height: 900, minWidth: 1024, minHeight: 700 };

/**
 * The fleetd dir, shared with the CLI (app-pair.json) and the GPUI app (hub.json): `<appData>/fleetd`, i.e.
 * ~/Library/Application Support/fleetd or $XDG_CONFIG_HOME/fleetd. FLEETD_HOME moves it, for tests and the QA harness.
 */
const fleetdHome = process.env["FLEETD_HOME"];
const FLEETD_DIR = fleetdHome !== undefined && isAbsolute(fleetdHome) ? fleetdHome : join(app.getPath("appData"), "fleetd");
// Chromium's own state (caches, local storage) stays in a subdirectory, unless the caller chose one.
if (!app.commandLine.hasSwitch("user-data-dir")) app.setPath("userData", join(FLEETD_DIR, "desktop"));

harden();
const opener = new Opener();
// A second launch hands its fleetd:// link to the running instance and quits before opening anything. The lock is
// per userData directory, so this comes after it is set (and parallel QA runs, each with its own, don't collide).
const primary = listenForLinks(opener);
if (!primary) app.quit();

// Hubs behind a company or private CA: trust what the OS trusts, as the GPUI app did, not only Node's bundled roots.
tls.setDefaultCACertificates([...tls.getCACertificates("bundled"), ...tls.getCACertificates("system")]);

const hubMode = (): HubMode => {
  const request = fixtureRequest(process.env, RELEASE_BUILD);
  if (request.kind === "ignored") console.warn(request.reason);
  if (request.kind !== "fixture") {
    return { kind: "hub", credentials: osCredentialEnv(FLEETD_DIR, fleetdHome !== undefined), vars: process.env, transport: webSocketTransport };
  }
  const dir = process.env["FLEETD_FIXTURE_DIR"] ?? join(app.getAppPath(), "fixtures");
  return { kind: "fixture", fixture: loadFixture(request.name, dir) };
};

const createWindow = (mode: HubMode): BrowserWindow => {
  const mac = process.platform === "darwin";
  const placement = restorePlacement(LIMITS);
  const win = new BrowserWindow({
    ...placement.bounds,
    minWidth: LIMITS.minWidth,
    minHeight: LIMITS.minHeight,
    show: false,
    title: "fleetd",
    // Painted before the page is, so a dark system never flashes white.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111214" : "#ffffff",
    ...(mac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: (TOP_BAR - TRAFFIC_LIGHT) / 2 } } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // The page shows a "sample data" banner for as long as a fixture stands in for the hub.
      additionalArguments: mode.kind === "fixture" ? [`--fleetd-fixture=${mode.fixture.name}`] : [],
    },
  });
  win.once("ready-to-show", () => {
    if (placement.maximized) win.maximize();
    if (placement.fullScreen) win.setFullScreen(true);
    win.show();
  });
  trackPlacement(win);
  opener.attach(win);
  void win.loadURL(pageUrl());
  return win;
};

void app.whenReady().then(() => {
  if (!primary) return;
  lockSession(join(import.meta.dirname, "../renderer"));
  let mode: HubMode;
  try {
    mode = hubMode();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    app.exit(2);
    return;
  }
  const hub = new HubService(mode);
  registerIpc(hub, { opener, notifier: new Notifier(opener) });
  installMenu(opener);
  claimOnFirstRun();
  app.on("browser-window-focus", () => hub.windowFocused());
  powerMonitor.on("resume", () => hub.systemResumed());
  app.on("will-quit", () => hub.stop());
  opener.setHooks({
    create: () => void createWindow(mode),
    activateApp: () => {
      if (process.platform === "darwin") app.focus({ steal: true });
    },
  });
  createWindow(mode);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(mode);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
