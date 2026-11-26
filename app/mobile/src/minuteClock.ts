// One clock for every view that words a time ("2 min", "Yesterday"): it ticks on each minute while any view follows
// it, and runs no timer with none. A thread or the chats list draws dozens of times at once; each with a timer of its
// own kept that many timers going, each waking its own view at its own second.

const MINUTE_MS = 60_000;

export interface Timers {
  readonly now: () => number;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
}

export interface MinuteClock {
  /** The time at the last tick, the same between ticks. */
  readonly now: () => number;
  readonly subscribe: (listener: () => void) => () => void;
}

export const minuteClock = (timers: Timers): MinuteClock => {
  const listeners = new Set<() => void>();
  let nowMs = timers.now();
  let timer: unknown;
  const schedule = () => {
    // Just past the minute, so a time a view words from it has turned.
    timer = timers.setTimeout(tick, MINUTE_MS - (timers.now() % MINUTE_MS) + 50);
  };
  const tick = () => {
    nowMs = timers.now();
    schedule();
    for (const listener of listeners) listener();
  };
  return {
    now: () => nowMs,
    subscribe: (listener) => {
      if (listeners.size === 0) {
        nowMs = timers.now();
        schedule();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) timers.clearTimeout(timer);
      };
    },
  };
};

/** The app's. */
export const clock = minuteClock({ now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) });
