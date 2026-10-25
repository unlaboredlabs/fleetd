// Chart C: the person's minutes per day (per week on a long range), stacked by where fleetd saw them, at most five
// sources in a fixed order. Reviews are estimated from a floor per review, and say so in the legend; where hue
// can't carry identity (forced colours, print) their segments hatch. A separate chart from the merges, on its own
// axis, lined up day for day: merges and minutes never share a y scale.
import type { HumanSource } from "../../../../shared/contracts";
import { Text, cx } from "../../../ui";
import { ESTIMATED, SOURCES, SOURCE_LABEL, SOURCE_SLOT, fmtMs, humanTotal, minuteTicks, plural, type Column } from "../model";
import { Legend, StackedColumns, type CardLine, type Hover, type Series } from "./parts";
import s from "../Factory.module.css";

const SERIES: readonly Series<HumanSource>[] = SOURCES.map((x) => ({
  key: x,
  label: SOURCE_LABEL[x],
  slot: s[`s${SOURCE_SLOT[x]}`] ?? "",
  estimated: ESTIMATED.has(x),
}));

const tick = (ms: number): string => (ms === 0 ? "0" : fmtMs(ms));

export interface MinutesChartProps {
  readonly columns: readonly Column[];
  /** The period before's columns, when comparing. */
  readonly previous: readonly Column[] | undefined;
  readonly weekly: boolean;
  /** No repo in scope is on a host whose reviews fleetd reads. */
  readonly noReviews: boolean;
  readonly onHover: (h: Hover | undefined) => void;
}

export function MinutesChart({ columns, previous, weekly, noReviews, onHover }: MinutesChartProps) {
  const card = (c: Column) => {
    const total = humanTotal(c);
    const lines: CardLine[] = SOURCES.flatMap((x) => {
      const h = c.human.get(x);
      if (h === undefined || h.ms <= 0) return [];
      return [{ text: `${fmtMs(h.ms)} ${SOURCE_LABEL[x].toLowerCase()}${ESTIMATED.has(x) ? " (estimated)" : ""}, ${plural(h.touches, "act")}`, key: s[`s${SOURCE_SLOT[x]}`] }];
    });
    const was = previous?.[columns.indexOf(c)];
    if (was !== undefined) lines.push({ text: `≈ ${fmtMs(humanTotal(was))} the period before (${was.label})`, tone: "quiet" });
    return { title: `${c.label}: ${total === 0 ? "nothing seen" : `≈ ${fmtMs(total)}`}`, lines };
  };
  return (
    <section className={cx(s.chart)} aria-labelledby="factory-minutes">
      <div className={cx(s.chartHead)}>
        <Text as="h2" strong id="factory-minutes">
          {weekly ? "Your minutes per week, by source" : "Your minutes per day, by source"}
        </Text>
        <Text size="xs" tone="quiet">
          From what fleetd sees: chat, approvals, reviews, the app. Your editor and thinking time aren&apos;t in it.
          {noReviews ? " No repo here is on a host whose reviews fleetd can read, so reviews can't be counted." : ""}
        </Text>
        <Legend series={SERIES} compare={previous !== undefined} />
      </div>
      <StackedColumns
        label={`Your minutes per ${weekly ? "week" : "day"}, by source.`}
        columns={columns}
        previous={previous}
        series={SERIES}
        value={(c, x) => c.human.get(x)?.ms ?? 0}
        ticks={minuteTicks}
        tickLabel={tick}
        card={card}
        onHover={onHover}
      />
    </section>
  );
}
