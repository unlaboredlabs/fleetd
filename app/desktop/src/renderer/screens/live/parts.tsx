// What an agent is doing, as the agents view draws it: words, then its machine text cut in the middle.
import { useLayoutEffect, useRef, useState } from "react";
import { Tooltip, Truncate, cx, useBeatRef } from "../../ui";
import { middleEllipsis } from "./format";
import type { Tone } from "./words";
import s from "./lanes.module.css";

const TONE_CLASS: Partial<Record<Tone, string | undefined>> = {
  loud: s.loud,
  warning: s.warning,
  danger: s.danger,
  success: s.success,
};

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

/**
 * What an agent is doing now: words in the UI voice, then machine text in mono cut in the middle to the room it has.
 */
export function ActivityLine({ line }: { line: { readonly words: string; readonly machine?: string | undefined; readonly tone: Tone; readonly thinking?: boolean } }) {
  const scan = useBeatRef<HTMLSpanElement>(line.thinking === true);
  return (
    // Thinking, its words carry the sweep (base.css): alive, without a letter changing.
    <span ref={scan} className={cx(s.activity, TONE_CLASS[line.tone] ?? s.quietText)} data-sweep={line.thinking === true ? "" : undefined}>
      {line.machine !== undefined ? (
        <>
          <span className={s.words}>{line.words}</span>
          <MiddleCut text={line.machine} />
        </>
      ) : (
        // Words alone can be long (a queued or usage-limit reason): they take the room and end in an ellipsis.
        <span className={s.wordsFill}>
          <Truncate expand="none" size="xs" tone="inherit">
            {line.words}
          </Truncate>
        </span>
      )}
    </span>
  );
}
