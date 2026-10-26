// The app's hash routes (binding for every screen; the QA harness navigates by setting location.hash). A project's
// lead chat is the main surface, with its agents and PRs in the panel beside it (`/agents`, `/prs` after the
// project, and every other tab of panel/tabs.ts likewise); Status, Factory, Time and Settings are secondary.
// notes/electron-routes.md has the table.
import { isPanelTab, type PanelTab } from "../panel/tabs";

export type { PanelTab } from "../panel/tabs";

/** A project is (machine, project): the same repo can be checked out on two machines. */
export interface ProjectKey {
  readonly machineId: string;
  readonly projectId: string;
}

/** A PR: its repo ("owner/name"), or null to take the project's PR with that number. */
export interface PrKey {
  readonly repo: string | null;
  readonly number: number;
}

/** What the panel beside a project's chat shows: a tab's list, or one agent's work, one PR or one browser session from it. */
export type PanelView =
  | { readonly tab: "agents"; readonly agent: string | null }
  | { readonly tab: "prs"; readonly pr: PrKey | null }
  | { readonly tab: "sessions"; readonly session: string | null }
  | { readonly tab: Exclude<PanelTab, "agents" | "prs" | "sessions"> };

/** A tab's own view: its list, no item. */
export const listView = (tab: PanelTab): PanelView => {
  switch (tab) {
    case "agents":
      return { tab, agent: null };
    case "prs":
      return { tab, pr: null };
    case "sessions":
      return { tab, session: null };
    default:
      return { tab };
  }
};

/** Whether the view is one item of its tab (an agent, a PR, a session), with its list a Back away. */
export const hasItem = (view: PanelView): boolean =>
  view.tab === "agents" ? view.agent !== null : view.tab === "prs" ? view.pr !== null : view.tab === "sessions" ? view.session !== null : false;

export const SETTINGS_TABS = ["general", "notifications", "agents", "projects", "mcp", "prompts", "instructions", "memory", "automations", "skills"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export type SettingsView = "edit" | "compare" | "update";

export type Screen =
  /** `#/`: the last project opened, else the first; the frame resolves it once the projects have loaded. */
  | { readonly id: "home" }
  /**
   * A project's lead chat; `message` scrolls to one message (a clicked notification). `panel` opens the panel on a
   * view; without it the panel shows what the window last had, if it is open.
   */
  | { readonly id: "project"; readonly project: ProjectKey; readonly message: string | null; readonly panel?: PanelView }
  | { readonly id: "status" }
  /** Merges and what they cost the person (D33), for one project (`?project=<machine>/<project>`) or (null) all. */
  | { readonly id: "factory"; readonly project: ProjectKey | null }
  | { readonly id: "machines" }
  /** The time inspector, for one order or (null) the fleet. */
  | { readonly id: "time"; readonly orderId: string | null }
  | { readonly id: "projects.add" }
  /** A tab; `prompt`, `for` ("<machine>/<project>") and `view` link one prompt, a project's texts or a prompt's update. */
  | { readonly id: "settings"; readonly tab: SettingsTab; readonly prompt?: string; readonly for?: string; readonly view?: SettingsView }
  /** A fleetd://pair link prefills the hub and code; the screen still asks before it pairs. */
  | { readonly id: "onboarding"; readonly hub: string | null; readonly code: string | null };

export const HOME: Screen = { id: "home" };

const isSettingsTab = (tab: string | undefined): tab is SettingsTab => SETTINGS_TABS.some((t) => t === tab);

const decode = (segment: string): string | null => {
  try {
    const value = decodeURIComponent(segment);
    return value === "" ? null : value;
  } catch {
    return null;
  }
};

const prNumber = (segment: string | undefined): number | null =>
  segment !== undefined && /^[1-9][0-9]{0,9}$/u.test(segment) ? Number(segment) : null;

/** `12` or `<owner>/<name>/12` after the project; anything else opens the list alone. */
const prKey = (rest: ReadonlyArray<string>): PrKey | null => {
  const [a, b, c] = rest;
  if (rest.length === 1) {
    const number = prNumber(a);
    return number === null ? null : { repo: null, number };
  }
  const number = prNumber(c);
  return rest.length === 3 && number !== null ? { repo: `${a ?? ""}/${b ?? ""}`, number } : null;
};

/** `prs[/<pr>]`, `agents[/<lane>]`, `sessions[/<id>]` or another tab's name after the project; anything else, no view. */
const panelView = (rest: ReadonlyArray<string>): PanelView | null => {
  const [tab, ...item] = rest;
  if (tab === "prs") return { tab, pr: prKey(item) };
  if (tab === "agents") return { tab, agent: item.length === 1 ? (item[0] ?? null) : null };
  if (tab === "sessions") return { tab, session: item.length === 1 ? (item[0] ?? null) : null };
  return isPanelTab(tab) ? listView(tab) : null;
};

/** "<machine>/<project>": the project's id is everything after the first slash. */
const projectParam = (value: string | null): ProjectKey | null => {
  const at = value?.indexOf("/") ?? -1;
  if (value === null || at <= 0 || at === value.length - 1) return null;
  return { machineId: value.slice(0, at), projectId: value.slice(at + 1) };
};

const screenOf = (parts: ReadonlyArray<string>, query: URLSearchParams): Screen => {
  const [head, a, b] = parts;
  switch (head) {
    case "project": {
      if (a === undefined || b === undefined) return HOME;
      const panel = panelView(parts.slice(3));
      return { id: "project", project: { machineId: a, projectId: b }, message: query.get("message") || null, ...(panel === null ? {} : { panel }) };
    }
    case "status":
      return { id: "status" };
    case "factory":
      return { id: "factory", project: projectParam(query.get("project")) };
    case "time":
      return { id: "time", orderId: a === "order" && b !== undefined ? b : null };
    case "machines":
      return { id: head };
    case "projects":
      return a === "add" ? { id: "projects.add" } : HOME;
    case "settings": {
      const [prompt, project, view] = [query.get("prompt"), query.get("for"), query.get("view")];
      return {
        id: "settings",
        tab: isSettingsTab(a) ? a : "general",
        ...(prompt ? { prompt } : {}),
        ...(project ? { for: project } : {}),
        ...(view === "compare" || view === "update" ? { view } : {}),
      };
    }
    case "onboarding":
      return { id: "onboarding", hub: query.get("hub") || null, code: query.get("code") || null };
    default:
      // The removed surfaces (#/board, #/order, #/inbox, #/agents, #/prs) and anything unknown land on the home project.
      return HOME;
  }
};

/** Any hash, including a hand-typed or stale one, gives a screen; what isn't one is home. */
export const parseHash = (hash: string): Screen => {
  const raw = hash.replace(/^#\/?/u, "");
  const at = raw.indexOf("?");
  const path = at === -1 ? raw : raw.slice(0, at);
  const query = new URLSearchParams(at === -1 ? "" : raw.slice(at + 1));
  const parts: Array<string> = [];
  for (const segment of path.split("/")) {
    if (segment === "") continue;
    const value = decode(segment);
    if (value === null) return HOME;
    parts.push(value);
  }
  return screenOf(parts, query);
};

const panelPath = (view: PanelView): Array<string> => {
  if (view.tab === "agents") return view.agent === null ? ["agents"] : ["agents", view.agent];
  if (view.tab === "sessions") return view.session === null ? ["sessions"] : ["sessions", view.session];
  if (view.tab !== "prs") return [view.tab];
  const pr = view.pr;
  return pr === null ? ["prs"] : ["prs", ...(pr.repo === null ? [] : pr.repo.split("/", 2)), String(pr.number)];
};

const path = (screen: Screen): Array<string> => {
  switch (screen.id) {
    case "home":
      return [];
    case "project":
      return ["project", screen.project.machineId, screen.project.projectId, ...(screen.panel === undefined ? [] : panelPath(screen.panel))];
    case "time":
      return screen.orderId === null ? ["time"] : ["time", "order", screen.orderId];
    case "projects.add":
      return ["projects", "add"];
    case "settings":
      return ["settings", screen.tab];
    case "status":
    case "factory":
    case "machines":
    case "onboarding":
      return [screen.id];
  }
};

export const toHash = (screen: Screen): string => {
  const query = new URLSearchParams();
  if (screen.id === "project" && screen.message !== null) query.set("message", screen.message);
  if (screen.id === "onboarding") {
    if (screen.hub !== null) query.set("hub", screen.hub);
    if (screen.code !== null) query.set("code", screen.code);
  }
  if (screen.id === "factory" && screen.project !== null) query.set("project", `${screen.project.machineId}/${screen.project.projectId}`);
  if (screen.id === "settings") {
    if (screen.prompt !== undefined) query.set("prompt", screen.prompt);
    if (screen.for !== undefined) query.set("for", screen.for);
    if (screen.view !== undefined && screen.view !== "edit") query.set("view", screen.view);
  }
  // A project's "<machine>/<project>" reads as one in a copied link.
  const q = query.toString().replaceAll("%2F", "/");
  return `#/${path(screen).map(encodeURIComponent).join("/")}${q === "" ? "" : `?${q}`}`;
};

/** A project's chat with the panel on `panel`. */
export const panelRoute = (project: ProjectKey, panel: PanelView): Screen => ({ id: "project", project, message: null, panel });

export const sameProject = (a: ProjectKey | null, b: ProjectKey | null): boolean =>
  a === b || (a !== null && b !== null && a.machineId === b.machineId && a.projectId === b.projectId);
