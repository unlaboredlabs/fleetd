// The app's hash routes (binding for every screen; the QA harness navigates by setting location.hash). The inbox
// is a panel over any route, so it lives in the query: `#/order/W14?inbox&ask=A1`.

/** A project is (machine, project): the same repo can be checked out on two machines. */
export interface ProjectKey {
  readonly machineId: string;
  readonly projectId: string;
}

export const SETTINGS_TABS = ["general", "prompts", "instructions"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export type StatusScope =
  | { readonly kind: "fleet" }
  | { readonly kind: "project"; readonly project: ProjectKey }
  | { readonly kind: "order"; readonly orderId: string };

export type Screen =
  | { readonly id: "board"; readonly project: ProjectKey | null }
  | { readonly id: "order"; readonly orderId: string }
  | { readonly id: "status"; readonly scope: StatusScope }
  | { readonly id: "machines" }
  | { readonly id: "time" }
  | { readonly id: "projects.add" }
  | { readonly id: "settings"; readonly tab: SettingsTab }
  /** A fleetd://pair link prefills the hub and code; the screen still asks before it pairs. */
  | { readonly id: "onboarding"; readonly hub: string | null; readonly code: string | null }
  | { readonly id: "gallery" };

export interface Route {
  readonly screen: Screen;
  /** Null when the panel is closed; `askId` scrolls it to that ask. */
  readonly inbox: { readonly askId: string | null } | null;
}

export const BOARD: Screen = { id: "board", project: null };
export const HOME: Route = { screen: BOARD, inbox: null };

const isSettingsTab = (tab: string | undefined): tab is SettingsTab => SETTINGS_TABS.some((t) => t === tab);

const decode = (segment: string): string | null => {
  try {
    const value = decodeURIComponent(segment);
    return value === "" ? null : value;
  } catch {
    return null;
  }
};

const project = (machineId: string | undefined, projectId: string | undefined): ProjectKey | null =>
  machineId === undefined || projectId === undefined ? null : { machineId, projectId };

const screenOf = (parts: ReadonlyArray<string>, query: URLSearchParams): Screen => {
  const [head, a, b, c] = parts;
  switch (head) {
    case undefined:
    case "board":
      return { id: "board", project: project(a, b) };
    case "inbox":
      return BOARD;
    case "order":
      return a === undefined ? BOARD : { id: "order", orderId: a };
    case "status": {
      if (a === "order" && b !== undefined) return { id: "status", scope: { kind: "order", orderId: b } };
      const key = a === "project" ? project(b, c) : null;
      return { id: "status", scope: key === null ? { kind: "fleet" } : { kind: "project", project: key } };
    }
    case "machines":
    case "time":
    case "gallery":
      return { id: head };
    case "projects":
      return a === "add" ? { id: "projects.add" } : BOARD;
    case "settings":
      return { id: "settings", tab: isSettingsTab(a) ? a : "general" };
    case "onboarding":
      return { id: "onboarding", hub: query.get("hub") || null, code: query.get("code") || null };
    default:
      return BOARD;
  }
};

/** Any hash, including a hand-typed or stale one, gives a route; what isn't one is the board. */
export const parseHash = (hash: string): Route => {
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
  const inbox = parts[0] === "inbox" || query.has("inbox") ? { askId: query.get("ask") || null } : null;
  return { screen: screenOf(parts, query), inbox };
};

const statusPath = (scope: StatusScope): Array<string> => {
  switch (scope.kind) {
    case "fleet":
      return ["status"];
    case "project":
      return ["status", "project", scope.project.machineId, scope.project.projectId];
    case "order":
      return ["status", "order", scope.orderId];
  }
};

const path = (screen: Screen): Array<string> => {
  switch (screen.id) {
    case "board":
      return screen.project === null ? [] : ["board", screen.project.machineId, screen.project.projectId];
    case "order":
      return ["order", screen.orderId];
    case "status":
      return statusPath(screen.scope);
    case "projects.add":
      return ["projects", "add"];
    case "settings":
      return ["settings", screen.tab];
    case "machines":
    case "time":
    case "onboarding":
    case "gallery":
      return [screen.id];
  }
};

export const toHash = (route: Route): string => {
  const query = new URLSearchParams();
  if (route.screen.id === "onboarding") {
    if (route.screen.hub !== null) query.set("hub", route.screen.hub);
    if (route.screen.code !== null) query.set("code", route.screen.code);
  }
  if (route.inbox !== null) {
    query.set("inbox", "");
    if (route.inbox.askId !== null) query.set("ask", route.inbox.askId);
  }
  // `inbox=` reads as a flag; write it as one.
  const q = query.toString().replace(/(^|&)inbox=(?=&|$)/u, "$1inbox");
  return `#/${path(route.screen).map(encodeURIComponent).join("/")}${q === "" ? "" : `?${q}`}`;
};

export const sameProject = (a: ProjectKey | null, b: ProjectKey | null): boolean =>
  a === b || (a !== null && b !== null && a.machineId === b.machineId && a.projectId === b.projectId);
