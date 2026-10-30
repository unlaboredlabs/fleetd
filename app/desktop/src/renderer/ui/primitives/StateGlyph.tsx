// An agent's state as a small 3×3 dither cell (DESIGN.md): each state is a shape of lit cells, and the cells move
// between shapes when the state changes, so the glyph morphs rather than swaps. Working is grain (cells flicker on a
// stepped clock), thinking walks one lit cell round the ring, like a terminal spinner; every other state holds still:
// waiting a solid block, queued an open ring, paused two bars, done settled to the floor (its bottom row), failed a
// cross. With reduced motion the two live ones keep a still shape of their own. They step on the app's one beat
// (ui/lib/beat), not on CSS animations: each beat marks only the cells whose light changes (data-lit), so a list of
// them restyles a few cells, not all. Their frames are shared/glyph.ts, which the phone app draws too.
import { useCallback, useRef } from "react";
import { useBeat } from "../lib/beat";
import { CELLS, litOn, type GlyphState } from "../../../shared/glyph";
import s from "./StateGlyph.module.css";

export { litOn, type GlyphState };

/**
 * `settled`: a done or failed state from before you looked, shown without its wipe in. `still`: a live state's still
 * shape (a count's glyph, where only the shape speaks). `phase`: where in its loop a live glyph starts, 0 to 3, so a
 * list of them is out of step.
 */
export function StateGlyph({
  state,
  label,
  size = "md",
  settled = false,
  still = false,
  phase = 0,
}: {
  state: GlyphState;
  label?: string;
  size?: "sm" | "md";
  settled?: boolean;
  still?: boolean;
  phase?: number;
}) {
  const live = !still && (state === "working" || state === "thinking") ? state : undefined;
  const turn = Math.abs(Math.round(phase)) % 4;
  const box = useRef<HTMLSpanElement>(null);
  // The two live states step on the app's beat while they are on screen, writing only the cells that change.
  const step = useCallback(
    (beat: number) => {
      const cells = box.current?.children;
      if (live === undefined || cells === undefined) return;
      for (const i of CELLS) {
        const cell = cells[i];
        const lit = litOn(live, turn, i, beat) ?? null;
        if (cell === undefined || cell.getAttribute("data-lit") === lit) continue;
        if (lit === null) cell.removeAttribute("data-lit");
        else cell.setAttribute("data-lit", lit);
      }
    },
    [live, turn],
  );
  useBeat(live !== undefined, step);
  return (
    <span
      ref={box}
      className={settled ? `${s.glyph} ${s.settled}` : s.glyph}
      // A still live state has a name of its own, so the beat's rules pass it by.
      data-state={still && (state === "working" || state === "thinking") ? `${state}-still` : state}
      data-size={size}
      data-phase={String(turn)}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {CELLS.map((i) => (
        <span key={i} className={s.cell} />
      ))}
    </span>
  );
}
