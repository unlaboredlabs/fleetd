// A stand-in app for the QA self-test: the same window and security settings as the real one, showing pages with
// known violations and known-clean text, so the DOM checks are tested in a real layout engine.
import path from "node:path";
import { app, BrowserWindow } from "electron";

void app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => win.show());
  void win.loadFile(path.join(import.meta.dirname, "index.html"));
});
