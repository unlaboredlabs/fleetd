// Settings' links ride on the shell's route (shell/routes.ts): #/settings[/<tab>][?prompt=<id>&for=<machine>/<project>
// &view=compare|update]. They make a prompt, a project's texts and a prompt's update linkable, from the palette, a
// "default changed" notice or the screenshot suite.
import { useRoute } from "../shell/navigation";
import { parseHash, toHash, type Screen, type SettingsTab, type SettingsView } from "../shell/routes";

export type Tab = SettingsTab;
export type View = SettingsView;

export interface SettingsRoute {
  readonly tab: Tab;
  readonly prompt: string | null;
  readonly for: string | null;
  readonly view: View;
}

const settingsOf = (s: Screen): SettingsRoute =>
  s.id === "settings" ? { tab: s.tab, prompt: s.prompt ?? null, for: s.for ?? null, view: s.view ?? "edit" } : { tab: "general", prompt: null, for: null, view: "edit" };

export const parseRoute = (hash: string): SettingsRoute => settingsOf(parseHash(hash));

export const useSettingsRoute = (): SettingsRoute => settingsOf(useRoute());

type RouteParts = { tab: Tab; prompt?: string | null; for?: string | null; view?: View };

export const formatRoute = (r: RouteParts): string =>
  toHash({ id: "settings", tab: r.tab, ...(r.prompt ? { prompt: r.prompt } : {}), ...(r.for ? { for: r.for } : {}), ...(r.view ? { view: r.view } : {}) });

const last = new Map<Tab, string>();

/** Where a tab was left, so going back to it returns to the same prompt and project. */
export const tabHref = (tab: Tab): string => last.get(tab) ?? formatRoute({ tab });

/** A link to one prompt, in the scope the Prompts page was last showing. */
export const promptHref = (id: string): string => formatRoute({ tab: "prompts", prompt: id, for: parseRoute(tabHref("prompts")).for });

/**
 * Records where the page is without a history entry: a reload or a copied link lands here again. replaceState fires no
 * hashchange, so it sends one for the route's readers (the sidebar follows the page).
 */
export function replaceRoute(r: RouteParts) {
  const next = formatRoute(r);
  last.set(r.tab, next);
  if (window.location.hash === next) return;
  window.history.replaceState(window.history.state, "", next);
  window.dispatchEvent(new Event("hashchange"));
}
