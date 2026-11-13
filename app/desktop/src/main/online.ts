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
export const WAKE_EVENTS = ["resume", "unlock-screen"] as const;

export interface PowerEvents {
  on(event: (typeof WAKE_EVENTS)[number], listener: () => void): unknown;
  removeListener(event: (typeof WAKE_EVENTS)[number], listener: () => void): unknown;
}

/** Calls `woke` on each of WAKE_EVENTS and each time the network comes back; returns the stop. */
export const watchWake = (power: PowerEvents, isOnline: () => boolean, woke: () => void, everyMs: number = ONLINE_CHECK_MS): (() => void) => {
  const listener = () => woke();
  for (const event of WAKE_EVENTS) power.on(event, listener);
  const stopOnline = watchOnline(isOnline, woke, everyMs);
  return () => {
    for (const event of WAKE_EVENTS) power.removeListener(event, listener);
    stopOnline();
  };
};
