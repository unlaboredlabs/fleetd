import { isAbsolute, join } from "node:path";
import tls from "node:tls";
import { app, BrowserWindow, nativeTheme, powerMonitor } from "electron";
import { fixtureRequest, loadFixture } from "./hub/fixture";
import { osCredentialEnv } from "./hub/os";
import { HubService, type HubMode } from "./hub/service";
import { webSocketTransport } from "./hub/transport";
import { registerIpc } from "./ipc";
import { fixturePairingDeps } from "./pairing/fixture";
import { PairingService, realPairingDeps } from "./pairing/service";
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

const fixtureDir = (): string => process.env["FLEETD_FIXTURE_DIR"] ?? join(app.getAppPath(), "fixtures");
/** The same resolution as loadFixture: a name in the fixture dir, or an absolute path. */
const fixtureFile = (name: string): string => (isAbsolute(name) ? name : join(fixtureDir(), `${name}.json`));

/** The hub, or a fixture standing in for it; `fixtureFile` is also where pairing finds the fixture's `pair` section. */
const hubMode = (): { mode: HubMode; fixtureFile: string | null } => {
  const request = fixtureRequest(process.env, app.isPackaged);
  if (request.kind === "ignored") console.warn(request.reason);
  if (request.kind !== "fixture") {
    return {
      mode: { kind: "hub", credentials: osCredentialEnv(FLEETD_DIR, fleetdHome !== undefined), vars: process.env, transport: webSocketTransport },
      fixtureFile: null,
    };
  }
  return { mode: { kind: "fixture", fixture: loadFixture(request.name, fixtureDir()) }, fixtureFile: fixtureFile(request.name) };
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
  void win.loadURL(pageUrl());
  return win;
};

void app.whenReady().then(() => {
  lockSession(join(import.meta.dirname, "../renderer"));
  let mode: HubMode;
  let pairing: PairingService;
  let hub: HubService;
  try {
    const chosen = hubMode();
    mode = chosen.mode;
    const service = new HubService(mode);
    hub = service;
    const connect = (url: string, key: string) => service.connect({ url, key });
    const firstRun = () => service.state().phase === "unpaired";
    pairing = new PairingService(
      chosen.fixtureFile === null
        ? realPairingDeps(FLEETD_DIR, connect, firstRun)
        : fixturePairingDeps(chosen.fixtureFile, connect, firstRun),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    app.exit(2);
    return;
  }
  registerIpc(hub, pairing);
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
