// An agent's state as a small 3×3 dither cell (DESIGN.md): each state is a shape of lit cells, and the cells move
// between shapes when the state changes, so the glyph morphs rather than swaps. Working is grain (cells flicker on a
// stepped clock), thinking walks one lit cell round the ring, like a terminal spinner; every other state holds still:
// waiting a solid block, queued an open ring, paused two bars, done settled to the floor (its bottom row), failed a
// cross. With reduced motion the
// two live ones keep a still shape of their own.
import s from "./StateGlyph.module.css";

export type GlyphState = "working" | "thinking" | "waiting" | "queued" | "paused" | "done" | "failed";

// Loops stop while the window is hidden: nothing draws frames no one can see.
if (typeof document !== "undefined") {
  const still = () => document.documentElement.toggleAttribute("data-still", document.hidden);
  document.addEventListener("visibilitychange", still);
  still();
}

const CELLS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

/** `settled`: a done or failed state from before you looked, shown without its wipe in. */
export function StateGlyph({ state, label, size = "md", settled = false }: { state: GlyphState; label?: string; size?: "sm" | "md"; settled?: boolean }) {
  return (
    <span
      className={settled ? `${s.glyph} ${s.settled}` : s.glyph}
      data-state={state}
      data-size={size}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {CELLS.map((i) => (
        <span key={i} className={s.cell} />
      ))}
    </span>
  );
}
