// The five budgets (docs/build/electron-app-spec.md: measured on an M-series Mac, scripts/perf-mac.sh) and the
// regression rules the Linux CI job applies against perf/baseline-linux.json. CI runners are not the budget machine
// and differ from each other, so CI gates regressions only, and the app's start and keypress there only relative to a
// bare Electron window launched in the same job: the start over it, and both scaled by it (Rule.perRunner).

export interface Results {
  /** Fastest warm launch, ms from spawning the app until its window is shown and has painted its first content (startTimes). */
  readonly firstPaintMs: number;
  /** The same for a bare Electron window that paints one line of text (perf/reference), launched alternately with the app. */
  readonly firstPaintRefMs: number;
  /** firstPaintMs minus firstPaintRefMs: what the app adds to Electron's own start, which CI gates. */
  readonly firstPaintOverMs: number;
  /**
   * Fastest, ms from spawning the app until the chat it opens on shows its words (three rows in, no markdown
   * placeholder left, and its composer): the same warm launches as first paint.
   */
  readonly chatShownMs: number;
  /** chatShownMs minus firstPaintRefMs: what the app adds before its chat reads, over Electron's own start; CI gates it. */
  readonly chatOverMs: number;
  /**
   * The memory budget, MB, after 10 s idle: deduplicated memory summed over every app process. On Linux that is PSS;
   * on macOS the physical footprint (Activity Monitor's "Memory").
   */
  readonly idleMemoryMb: number;
  /** Summed RSS of the same processes, MB. For information only, never gated: it counts the shared Electron pages once per process. */
  readonly idleRssMb: number;
  /** Frames per second while wheel-scrolling back through the chat-long fixture's chat. The median of a few rounds' rates. */
  readonly scrollFps: number;
  /**
   * Frames per second while a reply from the lead streams into a long chat (the stream-in-long fixture: 1,550 messages
   * held, a delta every 100 ms, as the node sends them). The median of a few rounds' rates.
   */
  readonly streamFps: number;
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
  /**
   * The baseline is first scaled by this run's bare Electron start over the baseline's: what the app adds to a start
   * is its own JavaScript, as CPU-bound as Electron's start, so it reads ~1.3× a bare start on every runner while in
   * ms it spreads 1.5× between them (main's runs, Nov 13 to 23: chat over bare 248 ms on an EPYC 9V45, 259 on a Xeon
   * 6975P, 374 on an EPYC 7763). Unscaled, a fixed limit sat inside the 7763's own spread (352 to 403 for one app).
   * A key press is as CPU-bound: its p95 read 6.5 to 9.5 ms on a 6975P and 12.6 to 14.0 on a Xeon 8370C for the same
   * code, and a fixed 12.1 ms limit failed every 8370C run, while over the bare start it reads 0.034 to 0.053 on all
   * 81 runs of Nov 22 and 23.
   */
  readonly perRunner?: boolean;
}

export const RULES: Record<Metric, Rule> = {
  firstPaintMs: { label: "first paint", unit: "ms", higher: false, limit: 600 },
  firstPaintRefMs: { label: "bare Electron", unit: "ms", higher: false },
  firstPaintOverMs: { label: "app over bare", unit: "ms", higher: false, regress: { ratio: 0.3, slack: 60 }, perRunner: true },
  chatShownMs: { label: "chat shown", unit: "ms", higher: false },
  // What a start costs past first paint (the hub's data, the chat's rows and their markdown), which "app over bare"
  // never sees: rows that mounted blank and filled in ~300 ms later read as shown at first paint there.
  chatOverMs: { label: "chat over bare", unit: "ms", higher: false, regress: { ratio: 0.3, slack: 60 }, perRunner: true },
  idleMemoryMb: { label: "idle memory", unit: "MB", higher: false, limit: 300, regress: { ratio: 0.15, slack: 25 } },
  idleRssMb: { label: "(summed RSS)", unit: "MB", higher: false },
  // 60 fps, allowing 5% of frames to rAF jitter: below 57 means frames were dropped. CI reads about 58 a round
  // (55 before the chat's day formatters were cached), as a page of older messages landing under the reader costs a
  // few frames; perf/run.ts gates the median of five rounds.
  scrollFps: { label: "chat scroll", unit: "fps", higher: true, limit: 57, regress: { ratio: 0.07, slack: 3 } },
  // As scroll: each streamed delta rebuilds the chat's rows, so a cost per message held drops frames here first. CI reads
  // about 59 on an EPYC 9V45 runner and 49.5 on a 7763, so its baseline is the slower runner's; a formatter made per
  // message took it under 20.
  streamFps: { label: "chat streaming", unit: "fps", higher: true, limit: 57, regress: { ratio: 0.07, slack: 3 } },
  // A p95 over ~160 keys still moves with a few slow ones on a shared runner, hence the wide ratio and perf/run.ts's
  // median of five rounds; the slack only keeps a fast runner's few ms from failing on a single slow key.
  keyP95Ms: { label: "keypress to screen", unit: "ms", higher: false, limit: 16, regress: { ratio: 0.5, slack: 2 }, perRunner: true },
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

/** The baseline a run is judged against: `baseline`'s, scaled to this run's runner for a perRunner metric. */
export const runnerBase = (metric: Metric, results: Results, baseline: Results): number =>
  RULES[metric].perRunner ? (baseline[metric] * results.firstPaintRefMs) / baseline.firstPaintRefMs : baseline[metric];

export const regressions = (results: Results, baseline: Results): Array<{ metric: Metric; value: number; limit: number; base: number }> =>
  METRICS.flatMap((metric) => {
    const base = runnerBase(metric, results, baseline);
    const limit = regressionLimit(metric, base);
    if (limit === undefined) return [];
    const value = results[metric];
    const worse = RULES[metric].higher ? value < limit : value > limit;
    return worse ? [{ metric, value, limit, base }] : [];
  });

/** Warm launches' times, ms, the app's and the bare window's taken alternately (perf/run.ts firstPaint). */
export interface Launches {
  readonly app: ReadonlyArray<number>;
  readonly chat: ReadonlyArray<number>;
  readonly bare: ReadonlyArray<number>;
}

/**
 * The start's results from warm launches: the fastest of each. A shared runner's noise only ever adds time, and comes
 * in bursts of a second or so that slow a few launches in a row, the app's (which does more work) more than the bare
 * window's: on main at 6e93c42a7 the app read 368 to 911 ms and bare 195 to 404, and medians put the app 492 ms over
 * bare where its fastest launches put it 173, as on the green commit after it (176). On the 81 runs of Nov 22 and 23,
 * app over bare read 0.75 to 1.00× the bare start by the fastest launches and 0.30 to 2.19× by the medians.
 */
export const startTimes = ({ app, chat, bare }: Launches): Pick<Results, "firstPaintMs" | "firstPaintRefMs" | "firstPaintOverMs" | "chatShownMs" | "chatOverMs"> => {
  const firstPaintMs = Math.min(...app);
  const firstPaintRefMs = Math.min(...bare);
  const chatShownMs = Math.min(...chat);
  return { firstPaintMs, firstPaintRefMs, firstPaintOverMs: firstPaintMs - firstPaintRefMs, chatShownMs, chatOverMs: chatShownMs - firstPaintRefMs };
};

/** The gated start metrics, which perf/run.ts times again once before a regression in them counts, as it does keypress. */
export const START: ReadonlyArray<Metric> = ["firstPaintOverMs", "chatOverMs"];

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
