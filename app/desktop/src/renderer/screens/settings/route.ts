// Settings' links ride on the shell's route (shell/routes.ts): #/settings[/<tab>][?prompt=<id>&for=<machine>/<project>
// &view=compare|update], and the Hub group's #/settings/hub/<page>. They make a prompt, a project's texts and a
// prompt's update linkable, from the palette, a "default changed" notice or the screenshot suite.
import { useRoute } from "../shell/navigation";
import { isHubTab, parseHash, toHash, type Screen, type SettingsTab, type SettingsView } from "../shell/routes";

export { isHubTab };
export type Tab = SettingsTab;
export type View = SettingsView;

export interface SettingsRoute {
  readonly tab: Tab;
  readonly prompt: string | null;
  readonly for: string | null;
  readonly view: View;
  /** Hub › Machines: the machine whose page is open. */
  readonly machine?: string;
}

const settingsOf = (s: Screen): SettingsRoute =>
  s.id === "settings"
    ? { tab: s.tab, prompt: s.prompt ?? null, for: s.for ?? null, view: s.view ?? "edit", ...(s.machine === undefined ? {} : { machine: s.machine }) }
    : { tab: "general", prompt: null, for: null, view: "edit" };

export const parseRoute = (hash: string): SettingsRoute => settingsOf(parseHash(hash));

export const useSettingsRoute = (): SettingsRoute => settingsOf(useRoute());

type RouteParts = { tab: Tab; prompt?: string | null; for?: string | null; view?: View };

export const formatRoute = (r: RouteParts): string =>
  toHash({ id: "settings", tab: r.tab, ...(r.prompt ? { prompt: r.prompt } : {}), ...(r.for ? { for: r.for } : {}), ...(r.view ? { view: r.view } : {}) });

/** A project's pages, under Projects in the sidebar: all of the one project picked there (`for`). */
export const PROJECT_TABS: ReadonlyArray<Tab> = ["projects", "agents", "instructions", "automations", "prompts"];
export const isProjectTab = (tab: Tab): boolean => PROJECT_TABS.includes(tab);

const last = new Map<Tab, string>();
/** The project the project pages last showed: each of them opens on it. */
let lastProject: string | null = null;

/** Where a tab was left, so going back to it returns to the same prompt and project. */
export const tabHref = (tab: Tab): string => (isProjectTab(tab) ? formatRoute({ tab, for: lastProject }) : (last.get(tab) ?? formatRoute({ tab })));

/** The project a project page shows: the route's, else the last one shown, else the first of `projects`. */
export const projectFor = (route: Pick<SettingsRoute, "for">, projects: ReadonlyArray<{ machineId: string; projectId: string }> | undefined): string | null => {
  const known = (key: string | null) => key !== null && (projects === undefined || projects.some((p) => `${p.machineId}/${p.projectId}` === key));
  if (route.for !== null) return route.for;
  if (known(lastProject)) return lastProject;
  const first = projects?.[0];
  return first ? `${first.machineId}/${first.projectId}` : null;
};

/** A link to one prompt, of the project the project pages last showed. */
export const promptHref = (id: string): string => formatRoute({ tab: "prompts", prompt: id, for: lastProject });

/**
 * Records where the page is without a history entry: a reload or a copied link lands here again. replaceState fires no
 * hashchange, so it sends one for the route's readers (the sidebar follows the page).
 */
export function replaceRoute(r: RouteParts) {
  const next = formatRoute(r);
  last.set(r.tab, next);
  if (isProjectTab(r.tab) && r.for) lastProject = r.for;
  replaceHash(next);
}

/** The same for any hash. */
export function replaceHash(next: string) {
  if (window.location.hash === next) return;
  window.history.replaceState(window.history.state, "", next);
  window.dispatchEvent(new Event("hashchange"));
}
