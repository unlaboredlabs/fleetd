// The app's hash routes (binding for every screen; the QA harness navigates by setting location.hash). A project's
// lead chat is the main surface; Status, Time and Settings are secondary. notes/electron-routes.md has the table.

/** A project is (machine, project): the same repo can be checked out on two machines. */
export interface ProjectKey {
  readonly machineId: string;
  readonly projectId: string;
}

export const SETTINGS_TABS = ["general", "notifications", "agents", "prompts", "instructions"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export type Screen =
  /** `#/`: the last project opened, else the first; the frame resolves it once the projects have loaded. */
  | { readonly id: "home" }
  /** A project's lead chat; `message` scrolls to one message (a clicked notification). */
  | { readonly id: "project"; readonly project: ProjectKey; readonly message: string | null }
  | { readonly id: "status" }
  | { readonly id: "machines" }
  /** The time inspector, for one order or (null) the fleet. */
  | { readonly id: "time"; readonly orderId: string | null }
  | { readonly id: "projects.add" }
  | { readonly id: "settings"; readonly tab: SettingsTab }
  /** A fleetd://pair link prefills the hub and code; the screen still asks before it pairs. */
  | { readonly id: "onboarding"; readonly hub: string | null; readonly code: string | null }
  | { readonly id: "gallery" };

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

const screenOf = (parts: ReadonlyArray<string>, query: URLSearchParams): Screen => {
  const [head, a, b] = parts;
  switch (head) {
    case "project":
      return a === undefined || b === undefined ? HOME : { id: "project", project: { machineId: a, projectId: b }, message: query.get("message") || null };
    case "status":
      return { id: "status" };
    case "time":
      return { id: "time", orderId: a === "order" && b !== undefined ? b : null };
    case "machines":
    case "gallery":
      return { id: head };
    case "projects":
      return a === "add" ? { id: "projects.add" } : HOME;
    case "settings":
      return { id: "settings", tab: isSettingsTab(a) ? a : "general" };
    case "onboarding":
      return { id: "onboarding", hub: query.get("hub") || null, code: query.get("code") || null };
    default:
      // The removed surfaces (#/board, #/order, #/inbox) and anything unknown land on the home project.
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

const path = (screen: Screen): Array<string> => {
  switch (screen.id) {
    case "home":
      return [];
    case "project":
      return ["project", screen.project.machineId, screen.project.projectId];
    case "time":
      return screen.orderId === null ? ["time"] : ["time", "order", screen.orderId];
    case "projects.add":
      return ["projects", "add"];
    case "settings":
      return ["settings", screen.tab];
    case "status":
    case "machines":
    case "onboarding":
    case "gallery":
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
  const q = query.toString();
  return `#/${path(screen).map(encodeURIComponent).join("/")}${q === "" ? "" : `?${q}`}`;
};

export const sameProject = (a: ProjectKey | null, b: ProjectKey | null): boolean =>
  a === b || (a !== null && b !== null && a.machineId === b.machineId && a.projectId === b.projectId);
