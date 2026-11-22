// The KPI rows: four equal stat tiles, the factory measured by all four together (no hero figure), and under them the
// train's four (CI per PR, CI passing first time, review rounds, PRs sent back) once the hub reports them. Each has
// its label, the value, a signed delta against the period before (its colour by direction × which way is good, with
// an arrow, never colour alone), a line under it, and a 12-point sparkline in the quiet grey, the current point in
// the accent.
import type { ReactNode } from "react";
import type { MetricsTiles, PipelineTiles, SparkPoint } from "../../../shared/contracts";
import { Text, cx } from "../../ui";
import { delta, fmtAbout, fmtCount, fmtMs, fmtPct, plural, sparkPath, sparkValues, type Delta } from "./model";
import s from "./Factory.module.css";

const TONE = { good: "success", bad: "danger", flat: "quiet" } as const;

function Spark({ spark }: { spark: readonly SparkPoint[] }) {
  const w = 72;
  const h = 24;
  const { d, last } = sparkPath(sparkValues(spark), w, h);
  if (d === "") return null;
  return (
    <svg className={cx(s.spark)} width={w} height={h} aria-hidden>
      <path className={cx(s.sparkLine)} d={d} />
      {last !== undefined ? <circle className={cx(s.sparkNow)} cx={last.x} cy={last.y} r={3} /> : null}
    </svg>
  );
}

interface TileProps {
  readonly label: string;
  readonly value: string;
  readonly delta?: Delta | undefined;
  readonly versus: string;
  readonly under: ReactNode;
  readonly spark: readonly SparkPoint[];
  /** What the figure counts, on hover. */
  readonly hint?: string;
}

function Tile({ label, value, delta: d, versus, under, spark, hint }: TileProps) {
  return (
    <div className={cx(s.tile)} role="group" aria-label={label} title={hint}>
      <Text size="xs" tone="quiet">
        {label}
      </Text>
      <span className={cx(s.tileValue)}>
        <Text size="display" strong>
          {value}
        </Text>
        {d !== undefined ? (
          <Text size="xs" tone={TONE[d.tone]} title={versus}>
            {d.text}
          </Text>
        ) : null}
      </span>
      <span className={cx(s.tileFoot)}>
        <Text size="xs" tone="quiet">
          {under}
        </Text>
        <Spark spark={spark} />
      </span>
    </div>
  );
}

export interface TilesProps {
  readonly tiles: MetricsTiles;
  /** "in 30 days", "in this range". */
  readonly inRange: string;
  /** "vs the 30 days before". */
  readonly versus: string;
  readonly onSeen: () => void;
}

export function Tiles({ tiles, inRange, versus, onSeen }: TilesProps) {
  const { merged, orderToMerged: lead, human, throughFleetd: share } = tiles;
  const leadUnder = lead.n === 0 ? "No merges with an order yet" : `${lead.p90Ms === undefined ? "" : `p90 ${fmtMs(lead.p90Ms)} · `}${plural(lead.n, "PR")}`;
  return (
    <div className={cx(s.tiles)}>
      <Tile
        label="Merged per day"
        value={fmtCount(merged.perDay)}
        delta={delta(merged.perDay, merged.previousPerDay, "up", "count")}
        versus={versus}
        under={`${fmtCount(merged.n)} ${inRange}`}
        spark={merged.spark}
      />
      <Tile
        label="Order to merged"
        value={lead.medianMs === undefined ? "—" : fmtMs(lead.medianMs)}
        delta={delta(lead.medianMs, lead.previousMedianMs, "down", "ms")}
        versus={versus}
        under={leadUnder}
        spark={lead.spark}
      />
      <Tile
        label="Your minutes per merged PR"
        value={human.perPrMs === undefined ? "—" : fmtAbout(human.perPrMs)}
        delta={delta(human.perPrMs, human.previousPerPrMs, "down", "ms")}
        versus={versus}
        under={
          <>
            {`${fmtAbout(human.totalMs)} in all · `}
            <button type="button" className={cx(s.linkish)} onClick={onSeen}>
              from what fleetd sees
            </button>
          </>
        }
        spark={human.spark}
      />
      <Tile
        label="Through fleetd"
        value={share.pct === undefined ? "—" : fmtPct(share.pct)}
        delta={delta(share.pct, share.previousPct, "up", "pct")}
        versus={versus}
        under={share.madeByFleetdPct === undefined ? "Nothing merged yet" : `${fmtPct(share.madeByFleetdPct)} made by fleetd`}
        spark={share.spark}
      />
      {tiles.pipeline !== undefined ? <PipelineTileRow tiles={tiles.pipeline} versus={versus} /> : null}
    </div>
  );
}

/** "0.5" for a rate under 10, as the tiles' counts read. */
const rate = (v: number) => (v < 10 ? v.toFixed(1) : fmtCount(v));

function PipelineTileRow({ tiles, versus }: { tiles: PipelineTiles; versus: string }) {
  const { ci, firstPass, reviews, sentBack } = tiles;
  const ciUnder = [ci.p90Ms === undefined ? "" : `p90 ${fmtMs(ci.p90Ms)}`, ci.runnerPerPrMs === undefined ? "" : `${fmtMs(ci.runnerPerPrMs)} runner time`]
    .filter((x) => x !== "")
    .join(" · ");
  return (
    <>
      <Tile
        label="CI per PR"
        value={ci.medianMs === undefined ? "—" : fmtMs(ci.medianMs)}
        delta={delta(ci.medianMs, ci.previousMedianMs, "down", "ms")}
        versus={versus}
        under={ci.n === 0 ? "No CI runs read yet" : ciUnder}
        spark={ci.spark}
        hint="GitHub Actions wall time of the run each PR merged on: first job's start to last job's end. Runner time adds up every job, a batch's split over its PRs."
      />
      <Tile
        label="CI green first time"
        value={firstPass.pct === undefined ? "—" : fmtPct(firstPass.pct)}
        delta={delta(firstPass.pct, firstPass.previousPct, "up", "pct")}
        versus={versus}
        under={firstPass.flaky > 0 ? plural(firstPass.flaky, "flaky re-run") : `of ${plural(firstPass.n, "PR")}`}
        spark={firstPass.spark}
        hint="Merged PRs whose first CI run passed. A flaky re-run is a job that failed, then passed when the train ran it again."
      />
      <Tile
        label="Review rounds per PR"
        value={reviews.perPr === undefined ? "—" : rate(reviews.perPr)}
        delta={delta(reviews.perPr, reviews.previousPerPr, "down", "count")}
        versus={versus}
        under={reviews.blockingPerPr === undefined ? `of ${plural(reviews.n, "PR")}` : `${rate(reviews.blockingPerPr)} blocking findings per PR`}
        spark={reviews.spark}
        hint="Reviews of each merged PR, one per patch the train reviewed, and the findings that held it back."
      />
      <Tile
        label="Sent back"
        value={sentBack.pct === undefined ? "—" : fmtPct(sentBack.pct)}
        delta={delta(sentBack.pct, sentBack.previousPct, "down", "pct")}
        versus={versus}
        under={`${fmtCount(sentBack.conflicts)} for conflicts · ${fmtCount(sentBack.redCi)} for red CI`}
        spark={sentBack.spark}
        hint="Merged PRs the train sent back to their writer at least once: for a conflict with the base, or for red CI."
      />
    </>
  );
}
