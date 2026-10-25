// The KPI row: four equal stat tiles, the factory measured by all four together (no hero figure). Each has its
// label, the value, a signed delta against the period before (its colour by direction × which way is good, with an
// arrow, never colour alone), a line under it, and a 12-point sparkline in the quiet grey, the current point in
// the accent.
import type { ReactNode } from "react";
import type { MetricsTiles, SparkPoint } from "../../../shared/contracts";
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
}

function Tile({ label, value, delta: d, versus, under, spark }: TileProps) {
  return (
    <div className={cx(s.tile)} role="group" aria-label={label}>
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
    </div>
  );
}
