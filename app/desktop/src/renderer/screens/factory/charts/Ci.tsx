// Chart D: CI time per PR, one dot per merged PR the train ran CI on, on a linear time axis: GitHub Actions wall time
// of the run it merged on, or its share of runner time (every job's run time, a batch's split over its PRs). Each
// day's median (the hub's, over every PR, not just the listed ones) joins into a line, so a CI change shows as a step,
// and the period's median is the quiet rule labelled at the right. Under it, the slowest jobs, each with its median, p90 and the period before's median. The pointer only
// has to be nearest a dot, and the arrow keys walk the dots in time order.
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { CiJob, CiTile, MetricsDay, MetricsMerge, RepoCoverage } from "../../../../shared/contracts";
import { Segmented, Text, Truncate, cx } from "../../../ui";
import { dayLabel, dayX, delta, fmtMs, mergeName, minuteTicks, plural, repoName } from "../model";
import { BOTTOM, LEFT, PLOT_H, TOP, gutterFor, useWidth, type CardLine, type Hover } from "./parts";
import s from "../Factory.module.css";

const REACH = 24;

export type CiMeasure = "wall" | "runner";

const MEASURES = [
  { value: "wall", label: "Wall time" },
  { value: "runner", label: "Runner time" },
] as const;

const valueOf = (m: MetricsMerge, by: CiMeasure): number | undefined => (by === "wall" ? m.pipeline?.ciWallMs : m.pipeline?.runnerMs);

/** Each day's median from the hub, in day order: the trend line's points, over the whole range. */
export const dayMedians = (days: readonly MetricsDay[], by: CiMeasure): { day: string; ms: number }[] =>
  days.flatMap((d) => {
    const ms = by === "wall" ? d.pipeline?.ciMedianMs : d.pipeline?.runnerMedianMs;
    return ms === undefined ? [] : [{ day: d.day, ms }];
  });

/**
 * The axis's reach: the 98th percentile of the dots, the trend and the median, so one stuck run doesn't flatten the
 * rest; a dot past it sits on the top edge and its card says its time.
 */
export const reach = (values: readonly number[], also: readonly number[]): number => {
  const v = values.toSorted((a, b) => a - b);
  const p98 = v.length === 0 ? 0 : (v[Math.min(v.length - 1, Math.ceil(v.length * 0.98) - 1)] ?? 0);
  return Math.max(p98, ...also);
};

export interface CiChartProps {
  readonly merges: readonly MetricsMerge[];
  /** The range's days, oldest first: the x axis the column charts share, with each day's medians. */
  readonly days: readonly MetricsDay[];
  readonly tile: CiTile;
  readonly jobs: readonly CiJob[];
  readonly coverage: readonly RepoCoverage[];
  readonly onHover: (h: Hover | undefined) => void;
}

export function CiChart({ merges, days: dayList, tile, jobs, coverage, onHover }: CiChartProps) {
  const days = useMemo(() => dayList.map((d) => d.day), [dayList]);
  const [by, setBy] = useState<CiMeasure>("wall");
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const [active, setActive] = useState<number | undefined>();
  const dots = useMemo(
    () => merges.filter((m) => valueOf(m, by) !== undefined).toSorted((a, b) => a.mergedAt.localeCompare(b.mergedAt)),
    [merges, by],
  );
  const trend = useMemo(() => dayMedians(dayList, by), [dayList, by]);
  const medianMs = by === "wall" ? tile.medianMs : tile.runnerMedianMs;
  const values = dots.map((m) => valueOf(m, by) ?? 0);
  const ticks = minuteTicks(reach(values, [...trend.map((t) => t.ms), medianMs ?? 0]));
  const top = ticks.at(-1) ?? 60_000;
  const baseline = TOP + PLOT_H;
  const y = (v: number) => baseline - (Math.min(v, top) / top) * PLOT_H;
  const right = gutterFor(width);
  const plotW = Math.max(0, width - LEFT - right);
  const slot = days.length === 0 ? 0 : plotW / days.length;
  const index = useMemo(() => new Map(days.map((d, i) => [d, i])), [days]);
  const x = (iso: string) => LEFT + dayX(iso, index) * slot;
  const stride = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(plotW / 80))));
  const xTicks = days.flatMap((d, i) => (i % stride === 0 ? [{ day: d, at: LEFT + i * slot }] : []));
  // The trend breaks across a day with no PRs rather than drawing over it.
  let path = "";
  trend.forEach((p, i) => {
    const at = index.get(p.day);
    if (at === undefined) return;
    const before = trend[i - 1];
    const prev = before === undefined ? undefined : index.get(before.day);
    const cmd = prev !== undefined && at - prev === 1 ? "L" : "M";
    path += `${cmd}${(LEFT + (at + 0.5) * slot).toFixed(1)} ${y(p.ms).toFixed(1)}`;
  });
  const multiRepo = new Set(jobs.map((j) => j.repo)).size > 1;

  const show = (i: number, at?: { x: number; y: number }) => {
    const m = dots[i];
    const p = m?.pipeline;
    if (m === undefined || p === undefined) return;
    setActive(i);
    const r = box.current?.getBoundingClientRect();
    const lines: CardLine[] = [{ text: `${mergeName(m, coverage)}${m.title === undefined ? "" : `: ${m.title}`}` }];
    if (by === "wall" && p.runnerMs !== undefined) lines.push({ text: `${fmtMs(p.runnerMs)} runner time`, tone: "quiet" });
    if (by === "runner" && p.ciWallMs !== undefined) lines.push({ text: `${fmtMs(p.ciWallMs)} wall time`, tone: "quiet" });
    if (p.slowestJob !== undefined) lines.push({ text: `Slowest job: ${p.slowestJob.name}, ${fmtMs(p.slowestJob.ms)}`, tone: "quiet" });
    if (p.waitMs !== undefined && p.waitMs >= 60_000) lines.push({ text: `Waited ${fmtMs(p.waitMs)} for a runner`, tone: "warning" });
    if (p.ciRuns > 1) lines.push({ text: `${plural(p.ciRuns, "CI run")}${p.redRuns > 0 ? `, ${p.redRuns} red` : ""}`, tone: p.redRuns > 0 ? "warning" : "quiet" });
    if (p.flaky > 0) lines.push({ text: plural(p.flaky, "flaky re-run"), tone: "warning" });
    onHover({
      x: at?.x ?? (r?.left ?? 0) + x(m.mergedAt),
      y: at?.y ?? (r?.top ?? 0) + y(valueOf(m, by) ?? 0),
      card: { title: `${fmtMs(valueOf(m, by) ?? 0)} ${by === "wall" ? "CI wall time" : "runner time"}`, lines },
    });
  };
  const hide = () => {
    setActive(undefined);
    onHover(undefined);
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    let best: number | undefined;
    let dist = REACH * REACH;
    dots.forEach((m, i) => {
      const d = (x(m.mergedAt) - px) ** 2 + (y(valueOf(m, by) ?? 0) - py) ** 2;
      if (d <= dist) {
        dist = d;
        best = i;
      }
    });
    if (best === undefined) hide();
    else show(best, { x: e.clientX, y: e.clientY });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") {
      if (e.key === "Escape") hide();
      return;
    }
    e.preventDefault();
    const at = active ?? -1;
    show(Math.min(dots.length - 1, Math.max(0, e.key === "ArrowRight" ? at + 1 : at < 0 ? dots.length - 1 : at - 1)));
  };

  return (
    <section className={cx(s.chart)} aria-labelledby="factory-ci">
      <div className={cx(s.chartHead)}>
        <div className={cx(s.chartTitleRow)}>
          <Text as="h2" strong id="factory-ci">
            CI time per PR
          </Text>
          <Segmented<CiMeasure> label="CI time" options={MEASURES} value={by} onChange={setBy} />
        </div>
        <div className={cx(s.legend)} aria-hidden>
          <span className={cx(s.key)}>
            <span className={cx(s.swatchDotSoft)} />
            <Text size="xs" tone="quiet">
              A merged PR
            </Text>
          </span>
          <span className={cx(s.key)}>
            <span className={cx(s.trendKey)} />
            <Text size="xs" tone="quiet">
              Each day&apos;s median
            </Text>
          </span>
        </div>
      </div>
      <div ref={box} className={cx(s.plot)}>
        {width > 0 ? (
          <svg
            width={width}
            height={baseline + BOTTOM}
            role="img"
            aria-label={`CI ${by === "wall" ? "wall time" : "runner time"} for ${dots.length} PRs${medianMs === undefined ? "" : `, median ${fmtMs(medianMs)}`}: the list below has each one.`}
            tabIndex={dots.length > 0 ? 0 : -1}
            onKeyDown={onKey}
            onBlur={hide}
            onPointerMove={onMove}
            onPointerLeave={hide}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line className={cx(t === 0 ? s.baseline : s.grid)} x1={LEFT} x2={LEFT + plotW} y1={y(t)} y2={y(t)} />
                <text className={cx(s.tick)} x={LEFT - 6} y={y(t)} dy="0.32em" textAnchor="end">
                  {t === 0 ? "0" : fmtMs(t)}
                </text>
              </g>
            ))}
            {xTicks.map((t, i) => (
              <text key={t.day} className={cx(s.tick)} x={t.at} y={baseline + 14} textAnchor={i === 0 ? "start" : "middle"}>
                {dayLabel(t.day)}
              </text>
            ))}
            {dots.map((m, i) => (
              <circle
                key={`${m.repo}#${m.prNumber ?? m.sha ?? i}`}
                className={cx(s.dotSoft, active === i && s.dotActive)}
                cx={x(m.mergedAt)}
                cy={y(valueOf(m, by) ?? 0)}
                r={active === i ? 4 : 3}
              />
            ))}
            {medianMs !== undefined ? (
              <g>
                <line className={cx(s.median)} x1={LEFT} x2={LEFT + plotW} y1={y(medianMs)} y2={y(medianMs)} />
                {right > 24 ? (
                  <text className={cx(s.directLabel)} x={LEFT + plotW + 8} y={y(medianMs)} dy="0.32em">
                    {`median ${fmtMs(medianMs)}`}
                  </text>
                ) : null}
              </g>
            ) : null}
            {path !== "" ? <path className={cx(s.trend)} d={path} /> : null}
          </svg>
        ) : (
          <div style={{ height: baseline + BOTTOM }} />
        )}
      </div>
      {jobs.length > 0 ? <SlowestJobs jobs={jobs} multiRepo={multiRepo} /> : null}
    </section>
  );
}

/** Shown under the chart. */
const JOBS_SHOWN = 5;

function SlowestJobs({ jobs, multiRepo }: { jobs: readonly CiJob[]; multiRepo: boolean }) {
  const shown = jobs.slice(0, JOBS_SHOWN);
  const max = Math.max(1, ...shown.map((j) => j.p90Ms));
  return (
    <div className={cx(s.jobs)}>
      <Text size="xs" tone="quiet" id="factory-jobs">
        Slowest jobs
      </Text>
      <ul className={cx(s.jobList)} aria-labelledby="factory-jobs">
      {shown.map((j) => {
        const d = delta(j.medianMs, j.previousMedianMs, "down", "ms");
        const hint = `${plural(j.runs, "run")}${j.failed > 0 ? `, red in ${j.failed}` : ""}. Median ${fmtMs(j.medianMs)}, p90 ${fmtMs(j.p90Ms)} when it passed${
          j.previousMedianMs === undefined ? "" : `; ${fmtMs(j.previousMedianMs)} the period before`
        }.`;
        return (
          <li key={`${j.repo}\u0000${j.name}`} className={cx(s.job)} title={hint}>
            <span className={cx(s.jobName)}>
              <Truncate size="xs">{multiRepo ? `${j.name} · ${repoName(j.repo).split("/").pop() ?? ""}` : j.name}</Truncate>
            </span>
            <span className={cx(s.jobBar)} aria-hidden>
              <span className={cx(s.jobP90)} style={{ width: `${(j.p90Ms / max) * 100}%` }} />
              <span className={cx(s.jobMedian)} style={{ width: `${(j.medianMs / max) * 100}%` }} />
            </span>
            <span className={cx(s.jobTime)}>
              <Text size="xs" tabular>
                {fmtMs(j.medianMs)}
              </Text>
              {d !== undefined && d.tone !== "flat" ? (
                <Text size="xs" tone={d.tone === "good" ? "success" : "danger"} tabular>
                  {d.text}
                </Text>
              ) : null}
            </span>
          </li>
        );
      })}
      </ul>
    </div>
  );
}
