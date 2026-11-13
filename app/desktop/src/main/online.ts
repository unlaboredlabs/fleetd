// What wakes the hubs' links: the computer resuming, its screen unlocking, and the network coming back (Wi-Fi rejoined,
// a cable plugged in). Main has no event for the last, so Chromium's own reading (net.isOnline) is checked every few
// seconds. Each one has the hubs dial at once rather than at their next retry, or wait on a link that may be dead.

export const ONLINE_CHECK_MS = 2_000;

/** Calls `back` each time `isOnline` goes from false to true; returns the stop. */
export const watchOnline = (isOnline: () => boolean, back: () => void, everyMs: number = ONLINE_CHECK_MS): (() => void) => {
  let online = isOnline();
  const timer = setInterval(() => {
    const now = isOnline();
    if (now && !online) back();
    online = now;
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
};

/** powerMonitor's events that mean the person is back at the computer. */
export interface PowerEvents {
  on(event: "resume" | "unlock-screen", listener: () => void): unknown;
  removeListener(event: "resume" | "unlock-screen", listener: () => void): unknown;
}

/**
 * Calls `woke` when the computer resumes from sleep, and `inDoubt` when its screen unlocks (with or without a sleep
 * before) and each time the network comes back, when a link may still be fine; returns the stop.
 */
export const watchWake = (power: PowerEvents, isOnline: () => boolean, woke: () => void, inDoubt: () => void, everyMs: number = ONLINE_CHECK_MS): (() => void) => {
  const resumed = () => woke();
  const unlocked = () => inDoubt();
  power.on("resume", resumed);
  power.on("unlock-screen", unlocked);
  const stopOnline = watchOnline(isOnline, inDoubt, everyMs);
  return () => {
    power.removeListener("resume", resumed);
    power.removeListener("unlock-screen", unlocked);
    stopOnline();
  };
};
