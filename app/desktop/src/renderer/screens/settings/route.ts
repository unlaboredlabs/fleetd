// Settings' part of the route table (notes/electron-routes.md):
// #/settings[/<tab>][?prompt=<id>&for=<machine>/<project>&view=compare|update]. They make a prompt, a project's texts
// and a prompt's update linkable, from the palette, a "default changed" notice or the screenshot suite.
import { useSyncExternalStore } from "react";

export type Tab = "general" | "agents" | "prompts" | "instructions";
export const TABS: ReadonlyArray<Tab> = ["general", "agents", "prompts", "instructions"];

export type View = "edit" | "compare" | "update";

export interface SettingsRoute {
  readonly tab: Tab;
  readonly prompt: string | null;
  readonly for: string | null;
  readonly view: View;
}

export function parseRoute(hash: string): SettingsRoute {
  const [path = "", query = ""] = hash.replace(/^#/u, "").split("?", 2);
  const seg = path.split("/").filter(Boolean)[1];
  const tab = TABS.find((t) => t === seg) ?? "general";
  const q = new URLSearchParams(query);
  const view = q.get("view");
  return { tab, prompt: q.get("prompt"), for: q.get("for"), view: view === "compare" || view === "update" ? view : "edit" };
}

type RouteParts = { tab: Tab; prompt?: string | null; for?: string | null; view?: View };

export function formatRoute(r: RouteParts): string {
  const q = new URLSearchParams();
  if (r.prompt) q.set("prompt", r.prompt);
  if (r.for) q.set("for", r.for);
  if (r.view && r.view !== "edit") q.set("view", r.view);
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

/** A link to one prompt, in the scope the Prompts page was last showing. */
export const promptHref = (id: string): string => formatRoute({ tab: "prompts", prompt: id, for: parseRoute(tabHref("prompts")).for });

/** Records where the page is without a history entry or a hashchange: a reload or a copied link lands here again. */
export function replaceRoute(r: RouteParts) {
  const next = formatRoute(r);
  last.set(r.tab, next);
  if (window.location.hash !== next) window.history.replaceState(window.history.state, "", next);
}
