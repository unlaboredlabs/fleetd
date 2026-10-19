// The board's small pieces: the lane row, its activity bars, the PR track, the status mark.
import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { RoleTag, Tooltip, Truncate, cx, roleTint } from "../../ui";
import { bars } from "./bars";
import type { AgentLane, ChangeState, Spark } from "./contracts";
import { fmtElapsed, fmtTokens, middleEllipsis, parseMs, shortModel } from "./format";
import { type Line, type Tone, ROLE_WORD, describe, isFinal, isWorking, trackFill } from "./words";
import s from "./Board.module.css";

const TONE_CLASS: Partial<Record<Tone, string | undefined>> = {
  warning: s.warning,
  danger: s.danger,
  success: s.success,
};

/** A check drawn as a path, so it is the same in every font. */
export function Check({ className }: { className?: string }) {
  return (
    <svg className={cx(s.check, className)} viewBox="0 0 10 10" aria-label="done" role="img">
      <path d="M1.2 5.2 4 8 9 2" />
    </svg>
  );
}

/** The lane's mark: a check once done; nothing while it works (its edge says so); else a dot in the status colour. */
function Mark({ lane }: { lane: AgentLane }) {
  if (lane.status === "done") return <span className={s.mark}><Check /></span>;
  if (isWorking(lane.status)) return <span className={s.mark} />;
  const tone = lane.status === "waiting" ? s.warning : lane.status === "failed" ? s.danger : s.faintDot;
  return (
    <span className={s.mark}>
      <span className={cx(s.dot, tone)} />
    </span>
  );
}

/**
 * The activity line: words in the UI voice, then machine text in mono that ends in an ellipsis when the column is
 * short (with the full text on hover). Tool work reads loud; waiting on the model reads quiet with its time.
 */
export function ActivityLine({ line, working, step, stale }: { line: Line; working: boolean; step?: string | undefined; stale?: boolean | undefined }) {
  const loud = working && !line.thinking && line.tone !== "warning" && line.tone !== "danger";
  return (
    <span className={cx(s.activity, loud ? s.loud : s.quietText, TONE_CLASS[line.tone], stale && s.stale)}>
      <span className={s.words}>{line.words}</span>
      {line.machine !== undefined ? <MiddleCut text={line.machine} /> : null}
      {step !== undefined ? <span className={s.step}>{step}</span> : null}
    </span>
  );
}

let measure: CanvasRenderingContext2D | null | undefined;
/** The width of one character of `el`'s (monospaced) font. */
const charWidth = (el: HTMLElement): number => {
  measure ??= document.createElement("canvas").getContext("2d");
  if (!measure) return 7;
  measure.font = getComputedStyle(el).font;
  return measure.measureText("0000000000").width / 10 || 7;
};

/**
 * Machine text (a command, a path) cut once, in the middle, to the room it has, so both the program and its
 * target show; the whole text is in the tooltip. It is mono, so the room is a count of characters.
 */
export function MiddleCut({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The observer reports the first size as soon as it starts, then each change.
    const ro = new ResizeObserver(() => setFits(Math.max(3, Math.floor((el.clientWidth - 1) / charWidth(el)))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const shown = fits === undefined ? text : middleEllipsis(text, fits);
  // The measured box stays the same element whether or not the text is cut; only what is inside it changes.
  return (
    <span ref={ref} className={s.machine} data-text="truncate">
      {shown === text ? (
        text
      ) : (
        <Tooltip content={text}>
          <span tabIndex={0} aria-label={text}>
            {shown}
          </span>
        </Tooltip>
      )}
    </span>
  );
}

/**
 * Bars for the last minute of real work. A new bucket slides the bars left one slot, once, keyed by the bucket it
 * shows; under reduce-motion they jump. A lane with no spark yet draws nothing rather than a baseline that would
 * claim it is idle.
 */
export function ActivityBars({ spark, startedMs, role, now }: { spark: Spark | undefined; startedMs: number | undefined; role: AgentLane["role"]; now: number }) {
  if (!spark) return <span className={s.bars} />;
  const b = bars(spark, startedMs);
  const fresh = now - (parseMs(spark.endAt) ?? 0) < 2_200;
  const last = b.heights.length - 1;
  return (
    <span className={s.bars} style={{ "--tint": roleTint(role), "--slots": b.slots } as CSSProperties} aria-hidden>
      <span key={fresh ? spark.endAt : "still"} className={cx(s.plot, fresh && s.shift)}>
        {b.heights.map((h, i) =>
          h < 0 ? (
            <span key={i} className={s.slot} />
          ) : (
            <span key={i} className={s.slot}>
              <span
                className={cx(s.bar, h === 0 ? s.baseline : i === last ? s.newest : undefined)}
                style={h > 0 ? { height: `${Math.max(8, Math.round(h * 100))}%` } : undefined}
              />
            </span>
          ),
        )}
      </span>
    </span>
  );
}

/** A PR's progress as three short segments (review, CI, merged), filled as the words beside it say. */
export function Track({ state, review }: { state: ChangeState; review: number }) {
  const fill = trackFill(state, review);
  if (!fill) return null;
  return (
    <span className={cx(s.track, state === "merged" && s.merged)} aria-hidden>
      {fill.map((f, i) => (
        <span key={i} className={s.segment}>
          <span className={s.fill} style={{ transform: `scaleX(${f})` }} />
        </span>
      ))}
    </span>
  );
}

export type Density = "stage" | "card";

export interface LaneRowProps {
  readonly lane: AgentLane;
  readonly density: Density;
  /** Hub time, ms. */
  readonly now: number;
  readonly stale?: boolean | undefined;
  readonly onOpen?: ((lane: AgentLane) => void) | undefined;
}

/**
 * One agent: its role's tint on the edge (solid while it works), the role, what it is for, what it is doing now,
 * how long it has run, its activity bars and its tokens. Every row is one line at one height, so nothing jumps.
 */
export function LaneRow({ lane, density, now, stale, onOpen }: LaneRowProps) {
  const line = describe(lane);
  const working = isWorking(lane.status);
  const started = lane.status === "queued" ? undefined : parseMs(lane.startedAt);
  const ended = parseMs(lane.endedAt);
  const clock = started === undefined ? "" : fmtElapsed((ended ?? now) - started);
  const since = parseMs(lane.live?.activity?.since);
  // How long the current step has run: waiting on the model shows it from the first second ("thinking 0:12"), the
  // quiet state; a tool step once it has taken a while.
  const stepMs = working && since !== undefined ? now - since : undefined;
  const step = stepMs !== undefined && (line.thinking || stepMs >= 2000) ? fmtElapsed(stepMs) : undefined;
  const tokens = lane.live?.tokens;
  const solid = working || lane.status === "waiting";
  const running = !isFinal(lane.status) && lane.status !== "queued";
  return (
    <div
      className={cx(s.lane, density === "stage" ? s.stageLane : s.cardLane, onOpen && s.clickable)}
      style={{ "--tint": roleTint(lane.role) } as CSSProperties}
      data-lane={lane.laneId}
      data-status={lane.status}
      {...(onOpen
        ? {
            role: "button",
            tabIndex: 0,
            onClick: () => onOpen(lane),
            onKeyDown: (e: KeyboardEvent) => {
              if (e.key === "Enter") onOpen(lane);
            },
          }
        : {})}
    >
      <span className={cx(s.edge, solid && s.edgeSolid)} />
      <Mark lane={lane} />
      <RoleTag role={lane.role} width={84}>
        {ROLE_WORD[lane.role]}
      </RoleTag>
      {density === "stage" ? (
        <Truncate expand="none" size="sm" tone="quiet" className={cx(s.laneTitle)}>
          {lane.title}
        </Truncate>
      ) : (
        <Truncate expand="none" size="xs" tone="quiet" className={cx(s.model)}>
          {lane.model ? shortModel(lane.model) : ""}
        </Truncate>
      )}
      <ActivityLine line={line} working={working} step={step} stale={stale} />
      <span className={cx(s.clock, working ? s.loud : s.quietText)}>{clock}</span>
      {running ? <ActivityBars spark={lane.live?.spark} startedMs={started} role={lane.role} now={now} /> : <span className={s.bars} />}
      <span className={s.tokens}>{tokens ? fmtTokens(tokens.input + tokens.output) : ""}</span>
    </div>
  );
}
