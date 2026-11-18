// What only this browser knows of a team's Get started (state.ts): GitHub skipped (or asked of an organization's
// owner), and Skip for now pressed. Small, for the first run and the You menu to read without the page.
import { useEffect, useState } from "react";
import type { Screen } from "../shell/routes";

/** What this browser keeps for a team: GitHub skipped (or asked of an owner), and Skip for now pressed. */
export interface Kept {
  readonly github?: "skipped" | "requested";
  readonly later?: true;
}

const keyOf = (hub: string) => `fleetd.start.${hub}`;

export const readKept = (hub: string): Kept => {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(keyOf(hub)) ?? "{}");
    if (typeof raw !== "object" || raw === null) return {};
    const { github, later } = raw as Record<string, unknown>;
    return {
      ...(github === "skipped" || github === "requested" ? { github } : {}),
      ...(later === true ? { later } : {}),
    };
  } catch {
    return {};
  }
};

const listeners = new Set<() => void>();

export const writeKept = (hub: string, change: Partial<Record<keyof Kept, Kept[keyof Kept] | null>>): void => {
  const was = readKept(hub);
  const next = Object.fromEntries(Object.entries({ ...was, ...change }).filter(([, v]) => v !== null && v !== undefined));
  try {
    window.localStorage.setItem(keyOf(hub), JSON.stringify(next));
  } catch {
    // A browser that keeps nothing asks again next time: nothing is lost but the Skip.
  }
  for (const l of listeners) l();
};

export const useKept = (hub: string): Kept => {
  const [kept, setKept] = useState(() => readKept(hub));
  useEffect(() => {
    const again = () => setKept(readKept(hub));
    again();
    listeners.add(again);
    return () => void listeners.delete(again);
  }, [hub]);
  return kept;
};

/** Where Get started is for this team. */
export const startScreen = (hub: string): Screen => ({
  id: "start",
  sample: null,
  at: hub,
});
