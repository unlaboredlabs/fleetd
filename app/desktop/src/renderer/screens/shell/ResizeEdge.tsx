// The edge you drag to resize a side of the frame: the panel's left edge (panel.tsx) and the sidebar's right one
// (Shell.tsx).
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { keyedWidth, useWindowWidth } from "./panelWidth";
import { sidebarBounds } from "./sidebarWidth";
import s from "./shell.module.css";

export interface ResizeEdgeProps {
  /** Which side of what it resizes it sits on: on the left, dragging left widens it. */
  readonly edge: "left" | "right";
  readonly label: string;
  /** The id of what it resizes. */
  readonly controls: string;
  /** Where a drag sets `variable` as it moves. */
  readonly target: RefObject<HTMLElement | null>;
  readonly variable: string;
  readonly width: number;
  readonly min: number;
  readonly max: number;
  /** A width set, as a drag ends or by a key; null puts it back to its default. */
  readonly onSet: (width: number | null) => void;
}

/**
 * A vertical separator: drag it, or focus it and use the arrow keys (the one away from what it resizes widens it),
 * Home and End; Shift moves four steps. A double-click (or Enter) puts it back to its default. A drag holds the pointer
 * (so it never selects text or loses the drag over the content), moves the width on `target` alone and sets it once,
 * as it ends, so nothing in what it resizes renders again per frame.
 */
export function ResizeEdge({ edge, label, controls, target, variable, width, min, max, onSet }: ResizeEdgeProps) {
  const drag = useRef<{ x: number; from: number; now: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, from: width, now: width };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d === null) return;
    const moved = edge === "left" ? d.x - e.clientX : e.clientX - d.x;
    d.now = Math.round(Math.min(Math.max(d.from + moved, min), max));
    target.current?.style.setProperty(variable, `${String(d.now)}px`);
    e.currentTarget.setAttribute("aria-valuenow", String(d.now));
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d === null) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d.now !== d.from) onSet(d.now);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSet(null);
      return;
    }
    const next = keyedWidth(e.key, e.shiftKey, width, { min, max, initial: width }, edge);
    if (next === null) return;
    e.preventDefault();
    // Saved even when it is the width already shown: the default can follow the window, what you chose doesn't.
    onSet(next);
  };

  // A drag the window lost (a blur mid-drag) leaves no stray cursor behind.
  useEffect(() => {
    if (!dragging) return;
    document.documentElement.dataset["resizing"] = "";
    return () => {
      delete document.documentElement.dataset["resizing"];
    };
  }, [dragging]);

  return (
    <div
      className={s.resize}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${String(width)} pixels wide`}
      title="Drag to resize; double-click to reset"
      tabIndex={0}
      data-edge={edge}
      data-dragging={dragging ? "" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => onSet(null)}
      onKeyDown={onKeyDown}
    />
  );
}

/** The sidebar's right edge (sidebarWidth.ts), on `root`'s --sidebar-w: its bounds follow the window, so a resize
 *  renders only this again. */
export function SidebarEdge({ root, width, onSet }: { root: RefObject<HTMLElement | null>; width: number; onSet: (width: number | null) => void }) {
  const bounds = sidebarBounds(useWindowWidth());
  return <ResizeEdge edge="right" label="Resize the sidebar" controls="sidebar" target={root} variable="--sidebar-w" width={width} min={bounds.min} max={bounds.max} onSet={onSet} />;
}
