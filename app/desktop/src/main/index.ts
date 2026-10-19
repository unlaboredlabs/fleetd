import { isAbsolute, join } from "node:path";
import tls from "node:tls";
import { app, BrowserWindow, nativeTheme, powerMonitor } from "electron";
import { fixtureRequest, loadFixture } from "./hub/fixture";
import { osCredentialEnv } from "./hub/os";
import { HubService, type HubMode } from "./hub/service";
import { webSocketTransport } from "./hub/transport";
import { instrument } from "./instrument";
import { registerIpc } from "./ipc";
import { harden, lockSession, pageUrl } from "./security";

/** Height of the renderer's top bar; the macOS traffic lights are centred in it. */
const TOP_BAR = 44;
const TRAFFIC_LIGHT = 16;

/**
 * The fleetd dir, shared with the CLI (app-pair.json) and the GPUI app (hub.json): `<appData>/fleetd`, i.e.
 * ~/Library/Application Support/fleetd or $XDG_CONFIG_HOME/fleetd. FLEETD_HOME moves it, for tests and the QA harness.
 */
const fleetdHome = process.env["FLEETD_HOME"];
const FLEETD_DIR = fleetdHome !== undefined && isAbsolute(fleetdHome) ? fleetdHome : join(app.getPath("appData"), "fleetd");
// Chromium's own state (caches, local storage) stays in a subdirectory, unless the caller chose one.
if (!app.commandLine.hasSwitch("user-data-dir")) app.setPath("userData", join(FLEETD_DIR, "desktop"));

harden();

// Hubs behind a company or private CA: trust what the OS trusts, as the GPUI app did, not only Node's bundled roots.
tls.setDefaultCACertificates([...tls.getCACertificates("bundled"), ...tls.getCACertificates("system")]);

const hubMode = (): HubMode => {
  const request = fixtureRequest(process.env, app.isPackaged);
  if (request.kind === "ignored") console.warn(request.reason);
  if (request.kind !== "fixture") {
    return { kind: "hub", credentials: osCredentialEnv(FLEETD_DIR, fleetdHome !== undefined), vars: process.env, transport: webSocketTransport };
  }
  const dir = process.env["FLEETD_FIXTURE_DIR"] ?? join(app.getAppPath(), "fixtures");
  return { kind: "fixture", fixture: loadFixture(request.name, dir) };
};

const createWindow = (mode: HubMode): BrowserWindow => {
  const mac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
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
  win.once("ready-to-show", () => win.show());
  instrument(win);
  void win.loadURL(pageUrl());
  return win;
};

void app.whenReady().then(() => {
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
  registerIpc(hub);
  app.on("browser-window-focus", () => hub.windowFocused());
  powerMonitor.on("resume", () => hub.systemResumed());
  app.on("will-quit", () => hub.stop());
  createWindow(mode);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(mode);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
