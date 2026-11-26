// What only this browser knows of a team's Get started (state.ts): GitHub skipped (or asked of an organization's
// owner), and Skip for now pressed. Small, for the first run and the You menu to read without the page.
import { useEffect, useState } from "react";
import { parseHash, type Screen } from "../shell/routes";
import { githubReturnOf, withoutGithubReturn, type GithubReturn } from "./model";

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

let returned: { readonly said: GithubReturn; readonly to: Screen } | null | undefined;
let setupSeen = false;

/** GitHub's words in the address, once per page load, and the screen they came back to; the address cleaned of them. */
const readReturn = () => {
  if (returned !== undefined) return returned;
  const said = githubReturnOf(window.location.search);
  if (said !== null) window.history.replaceState(window.history.state, "", `${window.location.pathname}${withoutGithubReturn(window.location.search)}${window.location.hash}`);
  returned = said === null ? null : { said, to: parseHash(window.location.hash) };
  return returned;
};

/**
 * What GitHub's trip ended on, read once per page load from the address it came back to, which is cleaned of it at
 * once whatever screen that is (Get started, or Settings › Hub › Setup's Connect GitHub): the web app's boot calls
 * this before the app starts. Only a trip that came back to Get started is Get started's to show.
 */
export const takeGithubReturn = (): GithubReturn | null => {
  const back = readReturn();
  return back !== null && back.to.id === "start" ? back.said : null;
};

/** A trip that came back to Settings › Hub › Setup, until its GitHub page has shown it (sawSetupReturn). */
export const setupGithubReturn = (): GithubReturn | null => {
  const back = readReturn();
  return back !== null && !setupSeen && back.to.id === "settings" && back.to.tab === "hub.setup" ? back.said : null;
};

export const sawSetupReturn = (): void => {
  setupSeen = true;
};

/** For tests: read the address again. */
export const resetReturn = (): void => {
  returned = undefined;
  setupSeen = false;
};
