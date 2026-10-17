// Estimate calibration: a tier's measured actual/raw ratio and the ETA it gives a raw estimate. Pure.
import type { Eta } from "@fleetd/contracts";

/** The ratio used until a tier has MIN_SAMPLES done workstreams (DESIGN §6: leads are ~5x optimistic). */
export const PRIOR_RATIO = 5;
export const MIN_SAMPLES = 5;
export const P80_MIN_SAMPLES = 10;
/** How many of the tier's latest done workstreams the ratio looks at. */
export const WINDOW = 20;
/** actual/raw above this is an estimate miss. */
export const MISS_RATIO = 2;

export interface Calibration {
  readonly ratio: number;
  readonly samples: number;
  /** The 80th-percentile ratio, from P80_MIN_SAMPLES on. */
  readonly p80Ratio?: number;
}

const median = (sorted: ReadonlyArray<number>) => {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Nearest-rank percentile. */
const percentile = (sorted: ReadonlyArray<number>, p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;

/**
 * `ratios` are actual/raw of the tier's latest done workstreams; only the first WINDOW count. Non-positive ones are
 * dropped. `prior` is the playbook's estimatePrior where the workstream pinned one.
 */
export const calibrate = (ratios: ReadonlyArray<number>, prior: number = PRIOR_RATIO): Calibration => {
  const sorted = ratios
    .slice(0, WINDOW)
    .filter((r) => Number.isFinite(r) && r > 0)
    .sort((a, b) => a - b);
  const samples = sorted.length;
  if (samples < MIN_SAMPLES) return { ratio: prior, samples };
  return { ratio: median(sorted), samples, ...(samples >= P80_MIN_SAMPLES ? { p80Ratio: percentile(sorted, 0.8) } : {}) };
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export const etaOf = (rawMinutes: number, c: Calibration): Eta => ({
  rawMinutes,
  calibratedMinutes: round1(rawMinutes * c.ratio),
  ratio: Math.round(c.ratio * 100) / 100,
  samples: c.samples,
  ...(c.p80Ratio === undefined ? {} : { p80Minutes: round1(rawMinutes * c.p80Ratio) }),
});

const duration = (minutes: number) => {
  const m = Math.round(minutes);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 === 0 ? "" : `${String(m % 60).padStart(2, "0")}m`}`;
};

/** One line for digests, e.g. "eta 3h20m (raw 40m × 5, prior, 2 of 5 samples)" or "eta 1h (raw 30m × 2, 12 samples; p80 1h30m)". */
export const etaText = (eta: Eta): string => {
  const basis = eta.samples < MIN_SAMPLES ? `prior, ${eta.samples} of ${MIN_SAMPLES} samples` : `${eta.samples} samples`;
  const p80 = eta.p80Minutes === undefined ? "" : `; p80 ${duration(eta.p80Minutes)}`;
  return `eta ${duration(eta.calibratedMinutes)} (raw ${duration(eta.rawMinutes)} × ${eta.ratio}, ${basis}${p80})`;
};
