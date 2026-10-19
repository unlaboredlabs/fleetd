import { join } from "node:path";
import { app, BrowserWindow, nativeTheme } from "electron";
import { HubService } from "./hub/service";
import { registerIpc } from "./ipc";
import { PairingService, realPairingDeps } from "./pairing/service";
import { harden, lockSession } from "./security";

/** Height of the renderer's top bar; the macOS traffic lights are centred in it. */
const TOP_BAR = 44;
const TRAFFIC_LIGHT = 16;

harden();

const createWindow = (): BrowserWindow => {
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
    },
  });
  win.once("ready-to-show", () => win.show());
  const dev = process.env["ELECTRON_RENDERER_URL"];
  if (dev !== undefined && !app.isPackaged) void win.loadURL(dev);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  return win;
};

void app.whenReady().then(() => {
  lockSession();
  const hub = new HubService();
  const pairing = new PairingService(realPairingDeps((url, key) => hub.connect({ url, key })));
  registerIpc(hub, pairing);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
