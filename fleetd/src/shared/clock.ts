/** Epoch milliseconds; tests pass their own. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
