// A CSV's or a sheet's rows as a spreadsheet shows them: column letters over, row numbers beside, a first row that
// names the columns held at the top. Only the rows in view are drawn, so ten thousand scroll as lightly as ten. Cells
// select as in a spreadsheet: click, drag, Shift-click or the arrow keys; a letter or a number takes its column or
// row, the corner everything (or ⌘A). ⌘C copies the selection as cells a spreadsheet pastes; the line under the grid
// says its range, count, sum and average.
import { Copy } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Button, copyText, cx, Text } from "../../ui";
import { bounds, columnsOf, hasHeader, isIn, letters, rangeName, selectedText, step, summary, widthsOf, type Cell, type Selection } from "./grid";
import f from "./files.module.css";

const ROW = 26;
/** Rows drawn past each edge of the view. */
const OVER = 12;

const figures = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });

export function Table({ rows, more, note, tabs }: { rows: readonly (readonly string[])[]; more: boolean; note?: string | undefined; tabs?: ReactNode }) {
  const columns = Math.max(1, columnsOf(rows));
  const widths = useMemo(() => widthsOf(rows, columns), [rows, columns]);
  const header = useMemo(() => hasHeader(rows), [rows]);
  const gutter = Math.max(36, String(rows.length).length * 8 + 16);
  const total = gutter + widths.reduce((s, w) => s + w, 0);
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const [sel, setSel] = useState<Selection | null>(null);
  const dragging = useRef(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    const read = () => setView({ top: el.scrollTop, height: el.clientHeight });
    read();
    const seen = new ResizeObserver(read);
    seen.observe(el);
    return () => seen.disconnect();
  }, []);

  // Row 0 is held at the top when it is the header, and the rest scroll under it.
  const from = header ? 1 : 0;
  const first = Math.max(from, Math.floor(view.top / ROW) - OVER + from);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + OVER + from);

  const cellAt = (e: MouseEvent): { kind: "cell" | "col" | "row" | "all"; r: number; c: number } | undefined => {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-r],[data-col],[data-row],[data-all]") : null;
    if (el === null) return undefined;
    if (el.dataset.all !== undefined) return { kind: "all", r: 0, c: 0 };
    if (el.dataset.col !== undefined) return { kind: "col", r: 0, c: Number(el.dataset.col) };
    if (el.dataset.row !== undefined) return { kind: "row", r: Number(el.dataset.row), c: 0 };
    return { kind: "cell", r: Number(el.dataset.r), c: Number(el.dataset.c) };
  };
  const all: Selection = { anchor: [0, 0], focus: [rows.length - 1, columns - 1] };
  const onMouseDown = (e: MouseEvent) => {
    const at = cellAt(e);
    if (at === undefined || e.button !== 0) return;
    e.preventDefault();
    box.current?.focus({ preventScroll: true });
    if (at.kind === "all") return setSel(all);
    if (at.kind === "col") return setSel({ anchor: [0, at.c], focus: [rows.length - 1, at.c] });
    if (at.kind === "row") return setSel({ anchor: [at.r, 0], focus: [at.r, columns - 1] });
    dragging.current = true;
    const cell: Cell = [at.r, at.c];
    setSel((s) => (e.shiftKey && s !== null ? { anchor: s.anchor, focus: cell } : { anchor: cell, focus: cell }));
  };
  const onMouseMove = (e: MouseEvent) => {
    if (!dragging.current || (e.buttons & 1) === 0) {
      dragging.current = false;
      return;
    }
    const at = cellAt(e);
    if (at?.kind === "cell") setSel((s) => (s === null ? s : { anchor: s.anchor, focus: [at.r, at.c] }));
  };
  const reveal = ([r, c]: Cell) => {
    const el = box.current;
    if (el === null) return;
    // The letters and a held header row sit over the rows as they scroll.
    const held = ROW * (header ? 2 : 1);
    const y = held + (r - from) * ROW;
    if (r >= from && y < el.scrollTop + held) el.scrollTop = y - held;
    else if (r >= from && y + ROW > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW - el.clientHeight;
    const x = gutter + widths.slice(0, c).reduce((s, w) => s + w, 0);
    const w = widths[c] ?? 0;
    if (x < el.scrollLeft + gutter) el.scrollLeft = x - gutter;
    else if (x + w > el.scrollLeft + el.clientWidth) el.scrollLeft = x + w - el.clientWidth;
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "a") {
      e.preventDefault();
      setSel(all);
      return;
    }
    if (mod && e.key === "c" && sel !== null) {
      e.preventDefault();
      void copyText(selectedText(rows, sel));
      return;
    }
    const to = step(sel?.focus ?? [0, 0], e.key, rows.length, columns);
    if (to === undefined) return;
    e.preventDefault();
    setSel((s) => (e.shiftKey && s !== null ? { anchor: s.anchor, focus: to } : { anchor: to, focus: to }));
    reveal(to);
  };

  const line = (r: number) => {
    const row = rows[r] ?? [];
    return (
      <div key={r} className={cx(f.gridRow, r === 0 && header && f.gridHeader)} role="row" aria-rowindex={r + 1}>
        <span className={f.gridGutter} data-row={r} role="rowheader">
          {r + 1}
        </span>
        {widths.map((w, c) => {
          const v = row[c] ?? "";
          return (
            <span
              key={c}
              className={cx(f.gridCell, isIn(sel, r, c) && f.gridOn, sel?.focus[0] === r && sel.focus[1] === c && f.gridFocus)}
              style={{ width: w }}
              data-r={r}
              data-c={c}
              data-num={/^-?[\d,.]+%?$/u.test(v) ? "" : undefined}
              role="gridcell"
              title={v.length > 40 ? v : undefined}
            >
              {v}
            </span>
          );
        })}
      </div>
    );
  };

  const said = sel === null ? undefined : summary(rows, sel);
  const b = sel === null ? undefined : bounds(sel);
  return (
    <div className={f.table}>
      <div
        ref={box}
        className={f.grid}
        tabIndex={0}
        role="grid"
        aria-label="Table"
        aria-rowcount={rows.length}
        aria-colcount={columns}
        aria-multiselectable
        style={{ ["--gutter-width" as string]: `${String(gutter)}px` }}
        onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={() => (dragging.current = false)}
        onKeyDown={onKeyDown}
      >
        <div style={{ width: total }}>
          <div className={cx(f.gridRow, f.gridLetters)} role="row">
            <span className={f.gridGutter} data-all="" aria-label="Select all" />
            {widths.map((w, c) => (
              <span key={c} className={cx(f.gridCell, b !== undefined && c >= b.left && c <= b.right && f.gridMarked)} style={{ width: w }} data-col={c} role="columnheader">
                {letters(c)}
              </span>
            ))}
          </div>
          {header ? line(0) : null}
          <div style={{ height: (first - from) * ROW }} />
          {Array.from({ length: Math.max(0, last - first) }, (_, i) => line(first + i))}
          <div style={{ height: (rows.length - last) * ROW }} />
        </div>
      </div>
      <div className={f.status}>
        {tabs}
        {sel === null || said === undefined ? (
          <Text size="xs" tone="quiet" tabular>
            {`${figures.format(rows.length)}${more ? "+" : ""} rows · ${figures.format(columns)} ${columns === 1 ? "column" : "columns"}`}
          </Text>
        ) : (
          <>
            <Text size="xs" tabular>
              {rangeName(sel)}
            </Text>
            <Text size="xs" tone="quiet" tabular>
              {[`${figures.format(said.cells)} ${said.cells === 1 ? "cell" : "cells"}`, ...(said.sum === undefined ? [] : [`Sum ${figures.format(said.sum)}`, `Average ${figures.format(said.average ?? 0)}`])].join(" · ")}
            </Text>
            <Button size="sm" variant="quiet" icon={<Copy aria-hidden />} onClick={() => void copyText(selectedText(rows, sel))}>
              Copy
            </Button>
          </>
        )}
        {note !== undefined ? (
          <Text size="xs" tone="quiet" className={f.statusNote}>
            {note}
          </Text>
        ) : null}
      </div>
    </div>
  );
}
