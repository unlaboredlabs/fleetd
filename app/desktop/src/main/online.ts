// The network coming back (Wi-Fi rejoined, a cable plugged in): main has no event for it, so Chromium's own reading
// (net.isOnline) is checked every few seconds, and the hubs dial at once rather than at their next retry.

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
