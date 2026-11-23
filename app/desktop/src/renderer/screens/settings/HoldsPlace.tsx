// What a part of a settings page measured when it was last shown on this device, so the part keeps its place while the
// hub's answer is still to come and nothing under it moves when it lands (W842): a bot's computer, whose setup and
// image rows the answer brings, and the line under its How it merges. Kept in localStorage, a small value per part.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import s from "./settings.module.css";

const KEY = "fleetd.settings.kept";

function all(): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "{}");
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** What was kept for `id`, as it was kept; undefined when this device never showed it. */
export const keptOf = (id: string): unknown => all()[id];

/** Keeps `value` for `id`. */
export function keep(id: string, value: unknown): void {
  const kept = all();
  if (JSON.stringify(kept[id]) === JSON.stringify(value)) return;
  kept[id] = value;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    // Storage full or off: the part simply isn't held next time.
  }
}

/**
 * `children` at least as tall as they were when last shown while `ready` is false, their section's card filling it; once
 * it is, their height as shown, kept for the next time.
 */
export function HoldsPlace({ id, ready, children }: { id: string; ready: boolean; children: ReactNode }) {
  const [held] = useState(() => {
    const v = keptOf(id);
    return typeof v === "number" ? v : undefined;
  });
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!ready || el === null) return;
    const save = () => {
      if (el.offsetHeight > 0) keep(id, el.offsetHeight);
    };
    save();
    if (typeof ResizeObserver === "undefined") return;
    const seen = new ResizeObserver(save);
    seen.observe(el);
    return () => seen.disconnect();
  }, [id, ready]);
  return (
    <div ref={ref} {...(ready || held === undefined ? {} : { className: s.holding, style: { minHeight: held } })}>
      {children}
    </div>
  );
}
