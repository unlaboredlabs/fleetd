// Settings' part of the route table (notes/electron-routes.md): #/settings[/<tab>][?prompt=<id>&for=<machine>/<project>].
// `prompt` and `for` make a prompt (and a project's texts) linkable, from the palette or anywhere else.
import { useSyncExternalStore } from "react";

export type Tab = "general" | "prompts" | "instructions";
export const TABS: ReadonlyArray<Tab> = ["general", "prompts", "instructions"];

export interface SettingsRoute {
  readonly tab: Tab;
  readonly prompt: string | null;
  readonly for: string | null;
}

export function parseRoute(hash: string): SettingsRoute {
  const [path = "", query = ""] = hash.replace(/^#/u, "").split("?", 2);
  const seg = path.split("/").filter(Boolean)[1];
  const tab = TABS.find((t) => t === seg) ?? "general";
  const q = new URLSearchParams(query);
  return { tab, prompt: q.get("prompt"), for: q.get("for") };
}

export function formatRoute(r: { tab: Tab; prompt?: string | null; for?: string | null }): string {
  const q = new URLSearchParams();
  if (r.prompt) q.set("prompt", r.prompt);
  if (r.for) q.set("for", r.for);
  const qs = q.toString();
  return `#/settings/${r.tab}${qs ? `?${qs.replaceAll("%2F", "/")}` : ""}`;
}

const subscribe = (l: () => void) => {
  window.addEventListener("hashchange", l);
  return () => window.removeEventListener("hashchange", l);
};

export const useHash = () => useSyncExternalStore(subscribe, () => window.location.hash);

const last = new Map<Tab, string>();

/** Where a tab was left, so going back to it returns to the same prompt and project. */
export const tabHref = (tab: Tab): string => last.get(tab) ?? formatRoute({ tab });

/** Records where the page is without a history entry or a hashchange: a reload or a copied link lands here again. */
export function replaceRoute(r: { tab: Tab; prompt?: string | null; for?: string | null }) {
  const next = formatRoute(r);
  last.set(r.tab, next);
  if (window.location.hash !== next) window.history.replaceState(window.history.state, "", next);
}
