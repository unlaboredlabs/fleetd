// The four budgets (docs/build/electron-app-spec.md: measured on an M-series Mac, scripts/perf-mac.sh) and the
// regression rules the Linux CI job applies against perf/baseline-linux.json. CI runners are not the budget machine
// and differ from each other, so CI gates regressions only, and first paint there only relative to a bare Electron
// window launched in the same job.

export interface Results {
  /** Median, ms from spawning the app until its window is shown and has painted its first content (warm launches). */
  readonly firstPaintMs: number;
  /** The same for a bare Electron window that paints one line of text (perf/reference), launched alternately with the app. */
  readonly firstPaintRefMs: number;
  /** firstPaintMs minus firstPaintRefMs: what the app adds to Electron's own start, which CI gates. */
  readonly firstPaintOverMs: number;
  /**
   * The memory budget, MB, after 10 s idle: deduplicated memory summed over every app process. On Linux that is PSS;
   * on macOS the physical footprint (Activity Monitor's "Memory").
   */
  readonly idleMemoryMb: number;
  /** Summed RSS of the same processes, MB. For information only, never gated: it counts the shared Electron pages once per process. */
  readonly idleRssMb: number;
  /** Frames per second while wheel-scrolling back through the chat-long fixture's chat. */
  readonly scrollFps: number;
  /** p95, ms from a key press (its OS timestamp) to the presentation of the frame that shows it: Chromium's EventLatency. The median of a few rounds' p95s. */
  readonly keyP95Ms: number;
}

export type Metric = keyof Results;

interface Rule {
  readonly label: string;
  readonly unit: string;
  /** Whether bigger is better. */
  readonly higher: boolean;
  /** The budget, which the Mac run marks ok or MISS. */
  readonly limit?: number;
  /** Regressed (CI) when worse than the baseline by more than the larger of ratio × baseline and slack. */
  readonly regress?: { readonly ratio: number; readonly slack: number };
}

export const RULES: Record<Metric, Rule> = {
  firstPaintMs: { label: "first paint", unit: "ms", higher: false, limit: 600 },
  firstPaintRefMs: { label: "bare Electron", unit: "ms", higher: false },
  firstPaintOverMs: { label: "app over bare", unit: "ms", higher: false, regress: { ratio: 0.3, slack: 60 } },
  idleMemoryMb: { label: "idle memory", unit: "MB", higher: false, limit: 300, regress: { ratio: 0.15, slack: 25 } },
  idleRssMb: { label: "(summed RSS)", unit: "MB", higher: false },
  // 60 fps, allowing 5% of frames to rAF jitter: below 57 means frames were dropped.
  scrollFps: { label: "chat scroll", unit: "fps", higher: true, limit: 57, regress: { ratio: 0.1, slack: 3 } },
  // A p95 over ~160 keys still moves with a few slow ones on a shared runner, hence the wide slack and perf/run.ts's median of five rounds.
  keyP95Ms: { label: "keypress to screen", unit: "ms", higher: false, limit: 16, regress: { ratio: 0.5, slack: 8 } },
};

export const METRICS = Object.keys(RULES) as ReadonlyArray<Metric>;

/** Whether the value is within its budget; undefined for a metric without one. */
export const withinBudget = (metric: Metric, value: number): boolean | undefined => {
  const { limit, higher } = RULES[metric];
  if (limit === undefined) return undefined;
  return higher ? value >= limit : value < limit;
};

/** The worst value that still isn't a regression from `base`; undefined for a metric CI doesn't gate. */
export const regressionLimit = (metric: Metric, base: number): number | undefined => {
  const { regress, higher } = RULES[metric];
  if (regress === undefined) return undefined;
  const allowed = Math.max(Math.abs(base) * regress.ratio, regress.slack);
  return higher ? base - allowed : base + allowed;
};

export const regressions = (results: Results, baseline: Results): Array<{ metric: Metric; value: number; limit: number }> =>
  METRICS.flatMap((metric) => {
    const limit = regressionLimit(metric, baseline[metric]);
    if (limit === undefined) return [];
    const value = results[metric];
    const worse = RULES[metric].higher ? value < limit : value > limit;
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
