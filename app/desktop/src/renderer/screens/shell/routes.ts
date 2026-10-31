// The app's hash routes (binding for every screen; the QA harness navigates by setting location.hash). A project's
// lead chat is the main surface, with its agents and PRs in the panel beside it (`/agents`, `/prs` after the
// project, and every other tab of panel/tabs.ts likewise); Status, Factory (with its Agent time tab) and Settings are
// secondary.
// notes/electron-routes.md has the table. With several hubs, a route names its hub as `?at=<id>` (navigation.ts).
import { HUB_ID, type HubId } from "../../../shared/hubs";
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

/** What the panel beside a project's chat shows: a tab's list, or one agent's work, one PR or one session from it. */
export type PanelView =
  | { readonly tab: "agents"; readonly agent: string | null }
  | { readonly tab: "prs"; readonly pr: PrKey | null }
  | { readonly tab: "sessions"; readonly session: string | null }
  /** A Navi's skills, or one of them by name. */
  | { readonly tab: "skills"; readonly skill: string | null }
  | { readonly tab: Exclude<PanelTab, "agents" | "prs" | "sessions" | "skills"> };

/** A tab's own view: its list, no item. */
export const listView = (tab: PanelTab): PanelView => {
  switch (tab) {
    case "agents":
      return { tab, agent: null };
    case "prs":
      return { tab, pr: null };
    case "sessions":
      return { tab, session: null };
    case "skills":
      return { tab, skill: null };
    default:
      return { tab };
  }
};

/** Whether the view is one item of its tab (an agent, a PR, a session, a skill), with its list a Back away. */
export const hasItem = (view: PanelView): boolean => {
  switch (view.tab) {
    case "agents":
      return view.agent !== null;
    case "prs":
      return view.pr !== null;
    case "sessions":
      return view.session !== null;
    case "skills":
      return view.skill !== null;
    default:
      return false;
  }
};

/**
 * Settings' pages, in one window (D211): You (General, Your accounts, Your memory, Your devices, Hubs); a project's (Project, Agents, Instructions
 * & memory, Automations and Prompts), all of the one project picked under Projects (`for`); and the Hub group, for the
 * hub's owners and admins only: People, Machines, Every project's Profiles, Tools & skills, Instructions & memory and
 * Prompts, Hub accounts, and Setup. A Hub page's tab is `hub.<page>`, its path `#/settings/hub/<page>`.
 */
export const SETTINGS_TABS = [
  "general",
  "accounts",
  "your-memory",
  "devices",
  "hubs",
  "projects",
  "agents",
  "instructions",
  "automations",
  "prompts",
  "hub.people",
  "hub.machines",
  "hub.profiles",
  "hub.tools",
  "hub.instructions",
  "hub.prompts",
  "hub.accounts",
  "hub.setup",
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export type HubTab = Extract<SettingsTab, `hub.${string}`>;
export type SettingsView = "edit" | "compare" | "update";

/** A page of the Hub group: an owner's or admin's only. */
export const isHubTab = (tab: SettingsTab): tab is HubTab => tab.startsWith("hub.");

/**
 * `at`: which of the app's hubs the screen is on (`?at=<id>`); absent, the hub of the screen before it
 * (navigation.ts). A single-hub app's routes never name it.
 */
export type Screen = ScreenOf & { readonly at?: HubId };

type ScreenOf =
  /** `#/`: the last project opened, else the first; the frame resolves it once the projects have loaded. */
  | { readonly id: "home" }
  /**
   * A project's lead chat; `message` scrolls to one message (a clicked notification). `panel` opens the panel on a
   * view; without it the panel shows what the window last had, if it is open.
   */
  | { readonly id: "project"; readonly project: ProjectKey; readonly message: string | null; readonly panel?: PanelView }
  | { readonly id: "status" }
  /** Your Navis: what Navi is, a new one, and the archived ones (navi/NaviScreen). */
  | { readonly id: "navi" }
  /** Merges and what they cost the person (D33), for one project (`?project=<machine>/<project>`) or (null) all. */
  | { readonly id: "factory"; readonly project: ProjectKey | null }
  /**
   * Factory's Agent time tab, the time inspector, for one order or (null) the fleet: `#/factory/time[/order/<id>]`.
   * The old `#/time` links land on it.
   */
  | { readonly id: "time"; readonly orderId: string | null }
  | { readonly id: "projects.add" }
  /**
   * A tab; `prompt`, `for` ("<machine>/<project>") and `view` link one prompt, a project's texts or a prompt's update
   * (Every project's prompts with no `for`); `machine` opens one machine's page under Hub › Machines.
   */
  | {
      readonly id: "settings";
      readonly tab: SettingsTab;
      readonly prompt?: string;
      readonly for?: string;
      readonly view?: SettingsView;
      readonly machine?: string;
    }
  /** A fleetd://pair link prefills the hub and code; the screen still asks before it pairs. */
  | { readonly id: "onboarding"; readonly hub: string | null; readonly code: string | null }
  /** The hub admin's setup: the welcome, one step open, or the end. */
  | { readonly id: "setup"; readonly view: string | null }
  /** One session in a window of its own (the pop-out, for taking over); the main window shows it in the panel. */
  | { readonly id: "session"; readonly project: ProjectKey; readonly session: string };

export const HOME: Screen = { id: "home" };

/** Where Settings' pages before D211 went: an older link lands on the page that has it now, for the same project. */
const SETTINGS_MOVED: Readonly<Record<string, SettingsTab>> = {
  connections: "accounts",
  claude: "accounts",
  github: "accounts",
  notifications: "general",
  memory: "instructions",
  skills: "agents",
  mcp: "agents",
  // Machine roles went to Hub › Machines.
  machines: "hub.machines",
};

/** Where Administration's pages went (D211): it is Settings' Hub group now, and an older link lands on its page. */
const ADMIN_MOVED: Readonly<Record<string, HubTab>> = {
  people: "hub.people",
  invites: "hub.people",
  machines: "hub.machines",
  connections: "hub.accounts",
  claude: "hub.accounts",
  github: "hub.accounts",
  hub: "hub.tools",
  skills: "hub.tools",
  setup: "hub.setup",
};

const isSettingsTab = (tab: string): tab is SettingsTab => SETTINGS_TABS.some((t) => t === tab);

const viewOf = (view: string | null): { view?: SettingsView } => (view === "compare" || view === "update" ? { view } : {});

/** `#/settings/hub/<page>[/<machine>]`: a Hub page; an unknown one is People. */
const hubScreen = (page: string | undefined, machine: string | undefined, query: URLSearchParams): ScreenOf => {
  const tab = `hub.${page ?? ""}`;
  const hubTab = isSettingsTab(tab) && isHubTab(tab) ? tab : "hub.people";
  if (hubTab === "hub.machines" && machine !== undefined) return { id: "settings", tab: hubTab, machine };
  const prompt = query.get("prompt");
  if (hubTab !== "hub.prompts" || !prompt) return { id: "settings", tab: hubTab };
  return { id: "settings", tab: hubTab, prompt, ...viewOf(query.get("view")) };
};

/** `#/admin/<section>[/<machine>]`, Administration's before D211: the Hub page that has it now. */
const adminScreen = (section: string | undefined, machine: string | undefined, query: URLSearchParams): ScreenOf => {
  const tab = (section === undefined ? undefined : ADMIN_MOVED[section]) ?? "hub.people";
  if (tab === "hub.machines" && machine !== undefined) return { id: "settings", tab, machine };
  // Hub settings' prompts are Every project's now.
  const prompt = query.get("prompt");
  if (section === "hub" && prompt) return { id: "settings", tab: "hub.prompts", prompt, ...viewOf(query.get("view")) };
  return { id: "settings", tab };
};

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

/** `prs[/<pr>]`, `agents[/<lane>]`, `sessions[/<id>]`, `skills[/<name>]` or another tab's name after the project; else, no view. */
const panelView = (rest: ReadonlyArray<string>): PanelView | null => {
  const [tab, ...item] = rest;
  if (tab === "prs") return { tab, pr: prKey(item) };
  if (tab === "agents") return { tab, agent: item.length === 1 ? (item[0] ?? null) : null };
  if (tab === "sessions") return { tab, session: item.length === 1 ? (item[0] ?? null) : null };
  if (tab === "skills") return { tab, skill: item.length === 1 ? (item[0] ?? null) : null };
  return isPanelTab(tab) ? listView(tab) : null;
};

/** "<machine>/<project>": the project's id is everything after the first slash. */
const projectParam = (value: string | null): ProjectKey | null => {
  const at = value?.indexOf("/") ?? -1;
  if (value === null || at <= 0 || at === value.length - 1) return null;
  return { machineId: value.slice(0, at), projectId: value.slice(at + 1) };
};

/** `order/<id>` after the time inspector's path; anything else is the fleet. */
const timeOf = (rest: ReadonlyArray<string>): ScreenOf => {
  const [a, b] = rest;
  return { id: "time", orderId: a === "order" && b !== undefined ? b : null };
};

const screenOf = (parts: ReadonlyArray<string>, query: URLSearchParams): ScreenOf => {
  const [head, a, b] = parts;
  switch (head) {
    case "project": {
      if (a === undefined || b === undefined) return HOME;
      const panel = panelView(parts.slice(3));
      return { id: "project", project: { machineId: a, projectId: b }, message: query.get("message") || null, ...(panel === null ? {} : { panel }) };
    }
    case "status":
      return { id: "status" };
    case "navi":
      return { id: "navi" };
    case "session": {
      const id = parts[3];
      return a === undefined || b === undefined || id === undefined ? HOME : { id: "session", project: { machineId: a, projectId: b }, session: id };
    }
    case "factory":
      if (a === "time") return timeOf(parts.slice(2));
      return { id: "factory", project: projectParam(query.get("project")) };
    case "time":
      // Time became Factory's Agent time tab; an older link still lands on it.
      return timeOf(parts.slice(1));
    case "projects":
      return a === "add" ? { id: "projects.add" } : HOME;
    case "settings": {
      if (a === "hub") return hubScreen(b, parts[3], query);
      const [prompt, project, view] = [query.get("prompt"), query.get("for"), query.get("view")];
      const tab = a !== undefined && isSettingsTab(a) && !isHubTab(a) ? a : ((a === undefined ? undefined : SETTINGS_MOVED[a]) ?? "general");
      if (isHubTab(tab)) return { id: "settings", tab };
      return {
        id: "settings",
        tab,
        ...(prompt ? { prompt } : {}),
        ...(project ? { for: project } : {}),
        ...viewOf(view),
      };
    }
    case "admin":
      return adminScreen(a, b, query);
    case "onboarding":
      return { id: "onboarding", hub: query.get("hub") || null, code: query.get("code") || null };
    case "setup":
      return { id: "setup", view: a ?? null };
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
  const screen = screenOf(parts, query);
  const hub = query.get("at");
  return hub !== null && HUB_ID.test(hub) ? { ...screen, at: hub } : screen;
};

const panelPath = (view: PanelView): Array<string> => {
  if (view.tab === "agents") return view.agent === null ? ["agents"] : ["agents", view.agent];
  if (view.tab === "sessions") return view.session === null ? ["sessions"] : ["sessions", view.session];
  if (view.tab === "skills") return view.skill === null ? ["skills"] : ["skills", view.skill];
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
      return screen.orderId === null ? ["factory", "time"] : ["factory", "time", "order", screen.orderId];
    case "projects.add":
      return ["projects", "add"];
    case "settings":
      return ["settings", ...screen.tab.split("."), ...(screen.machine === undefined ? [] : [screen.machine])];
    case "setup":
      return screen.view === null ? ["setup"] : ["setup", screen.view];
    case "session":
      return ["session", screen.project.machineId, screen.project.projectId, screen.session];
    case "status":
    case "navi":
    case "factory":
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
  if (screen.at !== undefined) query.set("at", screen.at);
  // A project's "<machine>/<project>" reads as one in a copied link.
  const q = query.toString().replaceAll("%2F", "/");
  return `#/${path(screen).map(encodeURIComponent).join("/")}${q === "" ? "" : `?${q}`}`;
};

/** A project's chat with the panel on `panel`. */
export const panelRoute = (project: ProjectKey, panel: PanelView): Screen => ({ id: "project", project, message: null, panel });

/** The same screen on hub `at`; none says the hub of the screen before. */
export const onHub = (screen: Screen, at: HubId | undefined): Screen => {
  if (at === undefined) {
    const { at: _at, ...rest } = screen;
    return rest;
  }
  return { ...screen, at };
};

export const sameProject = (a: ProjectKey | null, b: ProjectKey | null): boolean =>
  a === b || (a !== null && b !== null && a.machineId === b.machineId && a.projectId === b.projectId);
