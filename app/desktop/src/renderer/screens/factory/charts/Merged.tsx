// Chart A: landed changes per day (per week on a long range), stacked by route in the fixed order bottom up. It
// answers "how many" and "how much through fleetd" over time at once. Bots and skipped merges are not stacked; the
// column's card counts them. A click on a column narrows the merge list to its days.
import type { MetricsMerge } from "../../../../shared/contracts";
import { Text, cx } from "../../../ui";
import { ROUTE_FIELD, ROUTE_LABEL, ROUTE_SHORT, ROUTE_SLOT, ROUTES, inDays, niceTicks, plural, prList, routeTotal, skipLine, type Column, type Route } from "../model";
import { Legend, StackedColumns, type CardLine, type Hover, type Series } from "./parts";
import s from "../Factory.module.css";

const SERIES: readonly Series<Route>[] = ROUTES.map((r) => ({ key: r, label: ROUTE_LABEL[r], short: ROUTE_SHORT[r], slot: s[`s${ROUTE_SLOT[r]}`] ?? "" }));

export interface MergedChartProps {
  readonly columns: readonly Column[];
  /** The period before's columns, when comparing. */
  readonly previous: readonly Column[] | undefined;
  readonly merges: readonly MetricsMerge[];
  readonly weekly: boolean;
  readonly picked: Column | undefined;
  readonly onPick: (c: Column) => void;
  readonly onHover: (h: Hover | undefined) => void;
}

export function MergedChart({ columns, previous, merges, weekly, picked, onPick, onHover }: MergedChartProps) {
  const card = (c: Column) => {
    const total = routeTotal(c.merged);
    const lines: CardLine[] = ROUTES.filter((r) => c.merged[ROUTE_FIELD[r]] > 0).map((r) => ({
      text: `${c.merged[ROUTE_FIELD[r]]} ${ROUTE_LABEL[r].toLowerCase()}`,
      key: s[`s${ROUTE_SLOT[r]}`],
    }));
    const prs = prList(inDays(merges, c.from, c.to));
    if (prs !== undefined) lines.push({ text: prs, tone: "quiet" });
    const i = columns.indexOf(c);
    const was = previous?.[i];
    if (was !== undefined) lines.push({ text: `${routeTotal(was.merged)} the period before (${was.label})`, tone: "quiet" });
    for (const [why, n] of c.notCounted) lines.push({ text: skipLine(why, n), tone: "quiet" });
    return {
      title: `${c.label}: ${total === 0 ? "nothing merged" : plural(total, "merged", "merged")}`,
      lines,
      hint: total > 0 ? `Click to list ${weekly ? "that week's" : "that day's"} merges` : undefined,
    };
  };
  return (
    <section className={cx(s.chart)} aria-labelledby="factory-merged">
      <div className={cx(s.chartHead)}>
        <Text as="h2" strong id="factory-merged">
          {weekly ? "Merged per week, by route" : "Merged per day, by route"}
        </Text>
        <Legend series={SERIES} compare={previous !== undefined} />
      </div>
      <StackedColumns
        label={`Merged per ${weekly ? "week" : "day"}, by route: the list below has every number.`}
        columns={columns}
        previous={previous}
        series={SERIES}
        value={(c, r) => c.merged[ROUTE_FIELD[r]]}
        ticks={(max) => niceTicks(max)}
        tickLabel={String}
        card={card}
        picked={picked}
        onPick={onPick}
        directLabels
        onHover={onHover}
      />
    </section>
  );
}
