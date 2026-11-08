// A background loop the way the Rust hub's run: the step, then a sleep, until the hub stops. A step that throws is
// logged and the loop goes on.
import type { Hub } from "../api/hub.ts";

/** Waits `ms`, or less once `signal` aborts. */
export const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/** Runs `step` now and then every `ms` after the last one ended, until `hub.shutdown`. */
export function every(hub: Hub, what: string, ms: number, step: () => Promise<void> | void): void {
  const signal = hub.shutdown.signal;
  void (async () => {
    while (!signal.aborted) {
      try {
        await step();
      } catch (e) {
        console.error(`${what} failed:`, e);
      }
      await pause(ms, signal);
    }
  })();
}
