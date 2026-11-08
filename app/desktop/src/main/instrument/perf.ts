// FLEETD_PERF=1 (perf/run.ts): one stderr line with the wall-clock times of the launch milestones, so the budgets
// harness can time first paint from its own spawn without a debugger attached during startup.
import type { BrowserWindow } from "electron";
import type { Transport } from "../hub/transport";

// Runs in the page: the paint entries, as epoch ms. FCP waits for the first text or image, which the shell has.
const PAINTS = `new Promise((resolve) => {
  const read = () => ({ ...Object.fromEntries(performance.getEntriesByType("paint").map((e) => [e.name, performance.timeOrigin + e.startTime])), navigationStart: performance.timeOrigin });
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
  const created = Date.now();
  win.once("ready-to-show", () => {
    const shown = Date.now();
    void (win.webContents.executeJavaScript(PAINTS) as Promise<Record<string, number>>).then((paints) => {
      const fp = paints["first-paint"];
      const fcp = paints["first-contentful-paint"];
      console.error(
        `FLEETD_PERF launch main_start_epoch_ms=${mainStart.toFixed(1)} first_paint_epoch_ms=${fp?.toFixed(1) ?? "none"} first_contentful_paint_epoch_ms=${fcp?.toFixed(1) ?? "none"} ready_to_show_epoch_ms=${shown} window_created_epoch_ms=${created} load_start_epoch_ms=${paints["navigationStart"]?.toFixed(1) ?? "none"}`,
      );
    });
  });
};

/**
 * FLEETD_PERF with a real hub: one stderr line with the wall-clock times of the first connection's milestones (dialed,
 * socket open, the hub's ready and its first snapshot), so a harness can time launch to connected from its own spawn;
 * then a line with when each tool was first called, the window's first reads.
 */
export const timedTransport = (transport: Transport): Transport => {
  let reported = false;
  return (url, events) => {
    if (reported) return transport(url, events);
    reported = true;
    const at: Record<string, number> = { dial: Date.now() };
    let snapshotBytes = 0;
    const report = () =>
      console.error(`FLEETD_PERF hub ${Object.entries(at).map(([k, v]) => `${k}_epoch_ms=${v}`).join(" ")} snapshot_bytes=${snapshotBytes}`);
    // The first time each tool is called, as the reads the window makes after the snapshot, reported 5 s after it.
    const calls = new Map<string, number>();
    const connection = transport(url, {
      ...events,
      onOpen: () => {
        at["open"] = Date.now();
        events.onOpen();
      },
      onText: (text) => {
        if (at["snapshot"] === undefined) {
          const t = (JSON.parse(text) as { t?: unknown }).t;
          if (t === "ready") at["ready"] = Date.now();
          if (t === "snapshot") {
            snapshotBytes = text.length;
            events.onText(text);
            at["snapshot"] = Date.now();
            report();
            setTimeout(() => console.error(`FLEETD_PERF calls ${[...calls].map(([tool, ms]) => `${tool}=${ms}`).join(" ")}`), 5000);
            return;
          }
        }
        events.onText(text);
      },
    });
    return {
      ...connection,
      send: (text) => {
        const frame = JSON.parse(text) as { t?: unknown; tool?: unknown };
        if (frame.t === "call" && typeof frame.tool === "string" && !calls.has(frame.tool)) calls.set(frame.tool, Date.now());
        connection.send(text);
      },
    };
  };
};
