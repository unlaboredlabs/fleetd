// Your tapbacks on the lead's bubbles, one per bubble, kept on this device across launches (bubbles.ts says why they
// don't go to the hub). Picking the one already there takes it off.
import { useSyncExternalStore } from "react";
import type { Tapback } from "./bubbles";
import { TAPBACKS } from "./bubbles";

const STORAGE = "fleetd.tapbacks";
/** Bubbles kept per project; the oldest go first. */
const KEEP = 500;

type Marks = Readonly<Record<string, Readonly<Record<string, Tapback>>>>;

const isTapback = (v: unknown): v is Tapback => (TAPBACKS as readonly unknown[]).includes(v);

const load = (): Marks => {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE) ?? "{}");
    if (typeof raw !== "object" || raw === null) return {};
    const out: Record<string, Record<string, Tapback>> = {};
    for (const [project, marks] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof marks !== "object" || marks === null) continue;
      out[project] = Object.fromEntries(Object.entries(marks as Record<string, unknown>).filter((e): e is [string, Tapback] => isTapback(e[1])));
    }
    return out;
  } catch {
    return {};
  }
};

let marks: Marks | undefined;
const listeners = new Set<() => void>();
const empty: Readonly<Record<string, Tapback>> = {};

const read = (): Marks => (marks ??= load());

/** A bubble's key: its message and its place in it. */
export const bubbleKey = (messageId: string, part: string): string => `${messageId}/${part}`;

/** Sets your tapback on a bubble, or takes it off when it is the one there. */
export function toggleTapback(project: string, bubble: string, t: Tapback): void {
  const all = read();
  // Newest last, so the oldest go first past KEEP.
  const rest = Object.entries(all[project] ?? {}).filter(([k]) => k !== bubble);
  const was = all[project]?.[bubble];
  const next = was === t ? rest : [...rest, [bubble, t] as const];
  marks = { ...all, [project]: Object.fromEntries(next.slice(-KEEP)) };
  try {
    window.localStorage.setItem(STORAGE, JSON.stringify(marks));
  } catch {
    // Storage full or off: the mark lasts for this launch.
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The project's tapbacks by bubble key. */
export const useTapbacks = (project: string): Readonly<Record<string, Tapback>> =>
  useSyncExternalStore(subscribe, () => read()[project] ?? empty);

/** Tests start from what's in storage. */
export const resetTapbacks = (): void => {
  marks = undefined;
};
