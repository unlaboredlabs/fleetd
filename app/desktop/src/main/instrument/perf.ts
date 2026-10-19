// FLEETD_PERF=1 (perf/run.ts): one stderr line with the wall-clock times of the launch milestones, so the budgets
// harness can time first paint from its own spawn without a debugger attached during startup.
import type { BrowserWindow } from "electron";

// Runs in the page: the paint entries, as epoch ms. FCP waits for the first text or image, which the shell has.
const PAINTS = `new Promise((resolve) => {
  const read = () => Object.fromEntries(performance.getEntriesByType("paint").map((e) => [e.name, performance.timeOrigin + e.startTime]));
  const found = read();
  if (found["first-contentful-paint"] !== undefined) return resolve(found);
  new PerformanceObserver(() => {
    const now = read();
    if (now["first-contentful-paint"] !== undefined) resolve(now);
  }).observe({ type: "paint", buffered: true });
})`;

export const reportLaunch = (win: BrowserWindow): void => {
  // Node's timeOrigin is when this process started, before Electron loaded the app.
  const mainStart = performance.timeOrigin;
  win.once("ready-to-show", () => {
    const shown = Date.now();
    void (win.webContents.executeJavaScript(PAINTS) as Promise<Record<string, number>>).then((paints) => {
      const fp = paints["first-paint"];
      const fcp = paints["first-contentful-paint"];
      console.error(
        `FLEETD_PERF launch main_start_epoch_ms=${mainStart.toFixed(1)} first_paint_epoch_ms=${fp?.toFixed(1) ?? "none"} first_contentful_paint_epoch_ms=${fcp?.toFixed(1) ?? "none"} ready_to_show_epoch_ms=${shown}`,
      );
    });
  });
};
