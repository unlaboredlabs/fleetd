// FLEETD_PERF=1 (perf/run.ts): one stderr line with the wall-clock times of the launch milestones, and one when the chat
// first shows its words, so the budgets harness can time first paint and the chat from its own spawn without a
// debugger attached during startup.
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

// Runs in the page: when the chat the window opens on first shows its words, as epoch ms. At least three of the lead
// chat's rows with no markdown placeholder left in them (a row whose parser is still loading is blank), and its
// composer: what a person reads and types into, not rows that fill in later.
const CHAT_SHOWN = `new Promise((resolve) => {
  const shown = () => {
    const log = document.querySelector('[aria-label="Conversation with the lead"]');
    const composer = document.querySelector('textarea[aria-label="Message the lead"]');
    return log !== null && composer !== null && log.querySelectorAll('[role="listitem"]').length >= 3 && log.querySelector('[aria-busy="true"]') === null;
  };
  if (shown()) return resolve(performance.timeOrigin + performance.now());
  const watch = new MutationObserver(() => {
    if (!shown()) return;
    watch.disconnect();
    resolve(performance.timeOrigin + performance.now());
  });
  watch.observe(document, { subtree: true, childList: true, attributes: true });
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
    // Then the chat's words, a line of its own: a window that never opens a chat (onboarding) never prints it.
    void (win.webContents.executeJavaScript(CHAT_SHOWN) as Promise<number>).then((at) => console.error(`FLEETD_PERF chat words_epoch_ms=${at.toFixed(1)}`));
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
