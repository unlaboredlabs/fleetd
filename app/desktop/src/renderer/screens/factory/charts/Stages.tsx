// Chart E: where a merged PR's time in the train goes, per day (per week on a long range): the average PR's time in
// each stage, stacked in the order it goes through them. The writing before the PR opened is left to order to merged:
// it runs to hours and would flatten the stages the train controls. A column's card says how many PRs it averages and
// how many went back to their writer.
import { Text, cx } from "../../../ui";
import { STAGES, STAGE_HINT, STAGE_LABEL, STAGE_SLOT, fmtMs, minuteTicks, plural, stageMean, type Column, type Stage } from "../model";
import { Legend, StackedColumns, type CardLine, type Hover, type Series } from "./parts";
import s from "../Factory.module.css";

const SERIES: readonly Series<Stage>[] = STAGES.map((k) => ({ key: k, label: STAGE_LABEL[k], slot: s[`s${STAGE_SLOT[k]}`] ?? "" }));

const tick = (ms: number): string => (ms === 0 ? "0" : fmtMs(ms));

export interface StagesChartProps {
  readonly columns: readonly Column[];
  readonly previous: readonly Column[] | undefined;
  readonly weekly: boolean;
  readonly onHover: (h: Hover | undefined) => void;
}

export function StagesChart({ columns, previous, weekly, onHover }: StagesChartProps) {
  const card = (c: Column) => {
    const n = c.pipeline?.n ?? 0;
    if (n === 0) return { title: `${c.label}: nothing merged through the train`, lines: [] };
    const total = STAGES.reduce((a, k) => a + stageMean(c, k), 0);
    const lines: CardLine[] = STAGES.flatMap((k) => {
      const ms = stageMean(c, k);
      return ms <= 0 ? [] : [{ text: `${fmtMs(ms)} ${STAGE_HINT[k]}`, key: s[`s${STAGE_SLOT[k]}`] }];
    });
    const back = c.pipeline?.sentBack;
    if (back !== undefined && back.conflicts + back.redCi > 0) {
      lines.push({ text: `Sent back: ${plural(back.conflicts, "PR")} for conflicts, ${back.redCi} for red CI`, tone: "quiet" });
    }
    const was = previous?.[columns.indexOf(c)];
    if (was?.pipeline !== undefined && was.pipeline.n > 0) {
      lines.push({ text: `${fmtMs(STAGES.reduce((a, k) => a + stageMean(was, k), 0))} the period before (${was.label})`, tone: "quiet" });
    }
    return { title: `${c.label}: ${fmtMs(total)} per PR, over ${plural(n, "PR")}`, lines };
  };
  return (
    <section className={cx(s.chart)} aria-labelledby="factory-stages">
      <div className={cx(s.chartHead)}>
        <Text as="h2" strong id="factory-stages">
          Time in the train per PR, by stage
        </Text>
        <Legend series={SERIES} compare={previous !== undefined} />
      </div>
      <StackedColumns
        label={`The average merged PR's time in each of the train's stages, per ${weekly ? "week" : "day"}.`}
        columns={columns}
        previous={previous}
        series={SERIES}
        value={stageMean}
        ticks={minuteTicks}
        tickLabel={tick}
        card={card}
        onHover={onHover}
      />
    </section>
  );
}
