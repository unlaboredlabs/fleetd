// The lane's activity bars: the last minute of real work in the hub's buckets (tool calls started and model output
// streamed, as the hub counts them). Only the lane's own life is drawn: a lane that started 10 s ago has a few bars
// growing in from the right, not a minute of baseline it never lived.
import { SPARK_BUCKETS, SPARK_BUCKET_SECS, type Spark } from "./contracts";
import { parseMs } from "./format";

/**
 * One fixed scale for every lane and every moment: a full bar is this much work in a bucket (about four tool calls,
 * or a few hundred tokens written). Bars never rescale as a busy bucket rolls off, and two lanes' bars compare.
 */
const FULL = 64;
/** The fewest slots the width is divided into, so a young lane's few bars are readable, not slivers. */
export const MIN_SLOTS = 15;

/** Each bar's height as a fraction of the plot (0 is a quiet bucket, drawn as a baseline; -1 is a slot from before the lane started). */
export interface Bars {
  readonly heights: readonly number[];
  /** Slots the width is divided into. */
  readonly slots: number;
}

/** How many of the slots, from the left, end before the lane started: those are not drawn. */
export const unlived = (endMs: number, startedMs: number | undefined): number => {
  if (startedMs === undefined) return 0;
  const bucket = SPARK_BUCKET_SECS * 1000;
  let n = 0;
  while (n < SPARK_BUCKETS && endMs - (SPARK_BUCKETS - 1 - n) * bucket <= startedMs) n++;
  return n;
};

export const bars = (spark: Spark, startedMs: number | undefined): Bars => {
  const tail = spark.samples.slice(-SPARK_BUCKETS);
  const all = [...Array<number>(SPARK_BUCKETS - tail.length).fill(0), ...tail].map((v) => Math.min(1, v / FULL));
  const end = parseMs(spark.endAt);
  const lived = SPARK_BUCKETS - (end === undefined ? 0 : unlived(end, startedMs));
  const slots = Math.min(SPARK_BUCKETS, Math.max(MIN_SLOTS, lived));
  const shown = all.slice(SPARK_BUCKETS - slots);
  const dead = slots - Math.min(lived, slots);
  // -1 marks a slot from before the lane started: nothing is drawn there, not even the baseline.
  return { heights: shown.map((h, i) => (i < dead ? -1 : h)), slots };
};
