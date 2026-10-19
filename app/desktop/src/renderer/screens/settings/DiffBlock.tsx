import { useMemo, useState } from "react";
import { cx } from "../../ui";
import { diffLines, type DiffLine } from "./diff";
import s from "./settings.module.css";

/** Unchanged paragraphs kept around a change; longer unchanged runs fold behind a click. */
const CONTEXT = 1;

type Chunk = { kind: "line"; line: DiffLine; ix: number } | { kind: "fold"; from: number; to: number };

function chunks(d: ReadonlyArray<DiffLine>, open: ReadonlySet<number>): Chunk[] {
  const near = d.map((_, ix) => d.slice(Math.max(0, ix - CONTEXT), ix + CONTEXT + 1).some((l) => l.op !== "same"));
  const out: Chunk[] = [];
  let ix = 0;
  while (ix < d.length) {
    const line = d[ix];
    if (!line) break;
    if (near[ix] || line.op !== "same") {
      out.push({ kind: "line", line, ix });
      ix++;
      continue;
    }
    let end = ix;
    while (end < d.length && !near[end]) end++;
    if (open.has(ix) || end - ix < 3) {
      for (let k = ix; k < end; k++) out.push({ kind: "line", line: d[k] as DiffLine, ix: k });
    } else out.push({ kind: "fold", from: ix, to: end });
    ix = end;
  }
  return out;
}

/** The text `before` → `after`, by paragraph with changed words marked. */
export function DiffBlock(props: { before: string; after: string; label: string }) {
  const d = useMemo(() => diffLines(props.before, props.after), [props.before, props.after]);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  return (
    <div className={s.diff} role="region" aria-label={props.label} data-text="code">
      {chunks(d, open).map((c) =>
        c.kind === "fold" ? (
          <button key={`f${c.from}`} type="button" className={s.diffFold} onClick={() => setOpen(new Set(open).add(c.from))}>
            {c.to - c.from} unchanged {c.to - c.from === 1 ? "line" : "lines"}: show
          </button>
        ) : (
          <div key={c.ix} className={cx(s.diffLine, c.line.op === "add" ? s.diffAdd : c.line.op === "del" ? s.diffDel : s.diffSame)}>
            <span className={s.diffSign} aria-hidden>
              {c.line.op === "add" ? "+" : c.line.op === "del" ? "−" : ""}
            </span>
            <span>
              <span className={s.srOnly}>{c.line.op === "add" ? "Added: " : c.line.op === "del" ? "Removed: " : ""}</span>
              {c.line.words
                ? c.line.words.map((w, k) => (
                    <span key={k} className={w.op === "add" ? s.wordAdd : w.op === "del" ? s.wordDel : undefined}>
                      {w.text}
                    </span>
                  ))
                : c.line.text || " "}
            </span>
          </div>
        ),
      )}
    </div>
  );
}
