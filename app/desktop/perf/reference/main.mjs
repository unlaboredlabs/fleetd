// The first-paint reference (perf/run.ts): a bare Electron window, made as the app makes its own (size, hidden
// until ready-to-show, sandboxed), painting one line of text, and reporting the same FLEETD_PERF line. CI gates the
// app's first paint over this one, which moves with the runner but not with the app.
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

const PAINTS = `new Promise((resolve) => {
  const read = () => ({ ...Object.fromEntries(performance.getEntriesByType("paint").map((e) => [e.name, performance.timeOrigin + e.startTime])), navigationStart: performance.timeOrigin });
  const found = read();
  if (found["first-contentful-paint"] !== undefined) return resolve(found);
  new PerformanceObserver(() => {
    const now = read();
    if (now["first-contentful-paint"] !== undefined) resolve(now);
  }).observe({ type: "paint", buffered: true });
})`;

const mainStart = performance.timeOrigin;
void app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  const created = Date.now();
  win.once("ready-to-show", () => {
    const shown = Date.now();
    win.show();
    void win.webContents.executeJavaScript(PAINTS).then((/** @type {Record<string, number>} */ paints) => {
      const fcp = paints["first-contentful-paint"];
      console.error(
        `FLEETD_PERF launch main_start_epoch_ms=${mainStart.toFixed(1)} first_contentful_paint_epoch_ms=${fcp?.toFixed(1) ?? "none"} ready_to_show_epoch_ms=${shown} window_created_epoch_ms=${created} load_start_epoch_ms=${paints["navigationStart"]?.toFixed(1) ?? "none"}`,
      );
    });
  });
  void win.loadFile(join(import.meta.dirname, "index.html"));
});
