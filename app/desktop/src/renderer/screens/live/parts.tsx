// The strip's small pieces: an agent's row, its machine text cut in the middle, and the status mark.
import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { RoleTag, Tooltip, cx, roleTint } from "../../ui";
import { fmtElapsed, middleEllipsis, parseMs } from "./format";
import type { AgentRow } from "./strip";
import { type Tone, isWorking } from "./words";
import s from "./lanes.module.css";

const TONE_CLASS: Partial<Record<Tone, string | undefined>> = {
  loud: s.loud,
  warning: s.warning,
  danger: s.danger,
  success: s.success,
};

/** Nothing while it works (its solid edge says so); amber while it needs you or is stuck; faint while it waits its turn. */
function Mark({ status }: { status: AgentRow["lane"]["status"] }) {
  if (isWorking(status)) return <span className={s.mark} />;
  const tone = status === "waiting" || status === "stalled" ? s.warning : s.faintDot;
  return (
    <span className={s.mark}>
      <span className={cx(s.dot, tone)} />
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
    // Machine text (a command, a path, a URL) is the code voice: shown as written, cut once in the middle.
    <span ref={ref} className={s.machine} data-text="code">
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

export interface AgentLineProps {
  readonly row: AgentRow;
  /** Hub time, ms. */
  readonly now: number;
  readonly stale?: boolean | undefined;
  readonly onOpen?: (() => void) | undefined;
}

/**
 * One agent: its role's tint on the edge (solid while it works), the role, what it is doing now, and how long it
 * has run. One line at one height, so nothing jumps.
 */
export function AgentLine({ row, now, stale, onOpen }: AgentLineProps) {
  const { status, role } = row.lane;
  const started = parseMs(row.startedAt);
  const clock = started === undefined ? "" : fmtElapsed(now - started);
  const solid = isWorking(status) || status === "waiting";
  return (
    <div
      className={cx(s.lane, row.indent && s.indent, onOpen && s.clickable)}
      style={{ "--tint": roleTint(role) } as CSSProperties}
      data-lane={row.lane.laneId}
      data-status={status}
      {...(onOpen
        ? {
            role: "button",
            tabIndex: 0,
            onClick: onOpen,
            onKeyDown: (e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen();
              }
            },
          }
        : {})}
    >
      <span className={cx(s.edge, solid && s.edgeSolid)} />
      <Mark status={status} />
      <RoleTag role={role} width={84}>
        {row.roleWord}
      </RoleTag>
      <span className={cx(s.activity, TONE_CLASS[row.tone] ?? s.quietText, stale && s.stale)}>
        <span className={s.words}>{row.words}</span>
        {row.machine !== undefined ? <MiddleCut text={row.machine} /> : null}
      </span>
      <span className={cx(s.clock, isWorking(status) ? s.loud : s.quietText)} aria-label={clock === "" ? undefined : `for ${clock}`}>
        {clock}
      </span>
    </div>
  );
}
