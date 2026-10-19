// The four budgets (docs/build/electron-app-spec.md: measured on an M-series Mac) and the regression rule the
// Linux CI job applies against perf/baseline-linux.json. CI runners are not the budget machine, so CI fails on a
// regression from its own baseline, not on a budget.

export interface Results {
  /** Median, ms from spawning the app to its first contentful paint. */
  readonly firstPaintMs: number;
  /** Summed RSS of every app process, MB, after 10 s idle. */
  readonly idleRssMb: number;
  /** The same processes' unique memory (PSS, or the macOS footprint), MB: shared pages counted once. */
  readonly idleUniqueMb: number;
  /** Frames per second while wheel-scrolling the 20k-line log. */
  readonly scrollFps: number;
  /** p95, ms from a key reaching the page to the frame that shows it. */
  readonly keyP95Ms: number;
}

export type Metric = keyof Results;

interface Budget {
  readonly label: string;
  readonly unit: string;
  readonly limit: number;
  /** Whether bigger is better. */
  readonly higher: boolean;
  /** Regressed when worse than the baseline by more than both the ratio and the absolute slack. */
  readonly ratio: number;
  readonly slack: number;
}

export const BUDGETS: Record<Metric, Budget> = {
  firstPaintMs: { label: "first paint", unit: "ms", limit: 600, higher: false, ratio: 0.3, slack: 60 },
  // The spec says RSS; summed over Chromium's processes that counts the shared framework once per process, so the
  // unique figure is reported beside it against the same limit.
  idleRssMb: { label: "idle memory (RSS)", unit: "MB", limit: 300, higher: false, ratio: 0.15, slack: 25 },
  idleUniqueMb: { label: "idle memory (unique)", unit: "MB", limit: 300, higher: false, ratio: 0.15, slack: 25 },
  // 60 fps, allowing 5% of frames to rAF jitter: below 57 means frames were dropped.
  scrollFps: { label: "log scroll", unit: "fps", limit: 57, higher: true, ratio: 0.1, slack: 3 },
  // A p95 over ~50 keys moves with one or two slow keys, hence the wide slack.
  keyP95Ms: { label: "keypress to screen", unit: "ms", limit: 16, higher: false, ratio: 0.5, slack: 8 },
};

export const METRICS = Object.keys(BUDGETS) as ReadonlyArray<Metric>;

export const withinBudget = (metric: Metric, value: number): boolean => {
  const b = BUDGETS[metric];
  return b.higher ? value >= b.limit : value < b.limit;
};

/** The worst value that still isn't a regression from `base`. */
export const regressionLimit = (metric: Metric, base: number): number => {
  const b = BUDGETS[metric];
  const allowed = Math.max(Math.abs(base) * b.ratio, b.slack);
  return b.higher ? base - allowed : base + allowed;
};

export const regressions = (results: Results, baseline: Results): Array<{ metric: Metric; value: number; limit: number }> =>
  METRICS.flatMap((metric) => {
    const limit = regressionLimit(metric, baseline[metric]);
    const value = results[metric];
    const worse = BUDGETS[metric].higher ? value < limit : value > limit;
    return worse ? [{ metric, value, limit }] : [];
  });

export const median = (values: ReadonlyArray<number>): number => quantile(values, 0.5);

/** Nearest-rank quantile. */
export const quantile = (values: ReadonlyArray<number>, q: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN;
};

/** Frames per second over rAF timestamps, and the share of frames that took longer than 1.5 refresh intervals. */
export const frameStats = (stamps: ReadonlyArray<number>, refreshMs: number): { fps: number; dropped: number } => {
  if (stamps.length < 2) return { fps: 0, dropped: 1 };
  const first = stamps[0] ?? 0;
  const last = stamps[stamps.length - 1] ?? 0;
  let long = 0;
  for (let i = 1; i < stamps.length; i++) if ((stamps[i] ?? 0) - (stamps[i - 1] ?? 0) > refreshMs * 1.5) long += 1;
  return { fps: ((stamps.length - 1) * 1000) / (last - first), dropped: long / (stamps.length - 1) };
};
