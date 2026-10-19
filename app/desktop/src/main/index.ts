import { join } from "node:path";
import { app, BrowserWindow, nativeTheme } from "electron";
import { HubService } from "./hub/service";
import { registerIpc } from "./ipc";
import { installMenu } from "./menu";
import { Notifier } from "./notify";
import { listenForLinks, Opener } from "./opener";
import { harden, lockSession } from "./security";
import { restorePlacement, trackPlacement } from "./windowState";

/** Height of the renderer's top bar; the macOS traffic lights are centred in it. */
const TOP_BAR = 44;
const TRAFFIC_LIGHT = 16;

const LIMITS = { width: 1400, height: 900, minWidth: 1024, minHeight: 700 };

harden();
const opener = new Opener();
// A second launch hands its fleetd:// link to the running instance and quits before opening anything.
const primary = listenForLinks(opener);
if (!primary) app.quit();

const createWindow = (): BrowserWindow => {
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
    },
  });
  win.once("ready-to-show", () => {
    if (placement.maximized) win.maximize();
    if (placement.fullScreen) win.setFullScreen(true);
    win.show();
  });
  trackPlacement(win);
  opener.attach(win);
  const dev = process.env["ELECTRON_RENDERER_URL"];
  if (dev !== undefined && !app.isPackaged) void win.loadURL(dev);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  return win;
};

void app.whenReady().then(() => {
  if (!primary) return;
  lockSession();
  const hub = new HubService();
  registerIpc(hub, { opener, notifier: new Notifier(opener) });
  installMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
