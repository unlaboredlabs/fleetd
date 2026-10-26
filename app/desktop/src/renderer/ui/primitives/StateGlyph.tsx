// An agent's state as a small 3×3 dither cell (DESIGN.md): each state is a shape of lit cells, and the cells move
// between shapes when the state changes, so the glyph morphs rather than swaps. Working is grain (cells flicker on a
// stepped clock), thinking walks one lit cell round the ring, like a terminal spinner; every other state holds still:
// waiting a solid block, queued an open ring, paused two bars, done settled to the floor (its bottom row), failed a
// cross. With reduced motion the
// two live ones keep a still shape of their own. They step on the app's one beat (ui/lib/beat), not on CSS animations.
import { useBeat } from "../lib/beat";
import s from "./StateGlyph.module.css";

export type GlyphState = "working" | "thinking" | "waiting" | "queued" | "paused" | "done" | "failed";

const CELLS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

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
  // The two live states step on the app's beat while they are on screen.
  useBeat(!still && (state === "working" || state === "thinking"));
  return (
    <span
      className={settled ? `${s.glyph} ${s.settled}` : s.glyph}
      // A still live state has a name of its own, so the beat's rules pass it by.
      data-state={still && (state === "working" || state === "thinking") ? `${state}-still` : state}
      data-size={size}
      data-phase={String(Math.abs(Math.round(phase)) % 4)}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {CELLS.map((i) => (
        <span key={i} className={s.cell} />
      ))}
    </span>
  );
}
