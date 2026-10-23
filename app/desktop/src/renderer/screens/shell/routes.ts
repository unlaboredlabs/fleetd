// The app's hash routes (binding for every screen; the QA harness navigates by setting location.hash). A project's
// lead chat is the main surface; Status, Time and Settings are secondary. notes/electron-routes.md has the table.

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

/** One agent: its project and its lane. */
export interface AgentKey extends ProjectKey {
  readonly laneId: string;
}

export const SETTINGS_TABS = ["general", "notifications", "agents", "prompts", "instructions"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export type Screen =
  /** `#/`: the last project opened, else the first; the frame resolves it once the projects have loaded. */
  | { readonly id: "home" }
  /** A project's lead chat; `message` scrolls to one message (a clicked notification). */
  | { readonly id: "project"; readonly project: ProjectKey; readonly message: string | null }
  /** A project's pull requests; `pr` opens one beside the list. */
  | { readonly id: "prs"; readonly project: ProjectKey; readonly pr: PrKey | null }
  | { readonly id: "status" }
  /** Every agent across the projects; `agent` opens one's live work beside the list. */
  | { readonly id: "agents"; readonly agent: AgentKey | null }
  | { readonly id: "machines" }
  /** The time inspector, for one order or (null) the fleet. */
  | { readonly id: "time"; readonly orderId: string | null }
  | { readonly id: "projects.add" }
  | { readonly id: "settings"; readonly tab: SettingsTab }
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

const screenOf = (parts: ReadonlyArray<string>, query: URLSearchParams): Screen => {
  const [head, a, b, c] = parts;
  switch (head) {
    case "project":
      if (a === undefined || b === undefined) return HOME;
      return { id: "project", project: { machineId: a, projectId: b }, message: query.get("message") || null };
    case "prs":
      // Like the agents view's `agents/<machine>/<project>/<lane>`; the hub lists PRs a project at a time.
      return a === undefined || b === undefined ? HOME : { id: "prs", project: { machineId: a, projectId: b }, pr: prKey(parts.slice(3)) };
    case "status":
      return { id: "status" };
    case "agents":
      return { id: "agents", agent: a === undefined || b === undefined || c === undefined ? null : { machineId: a, projectId: b, laneId: c } };
    case "time":
      return { id: "time", orderId: a === "order" && b !== undefined ? b : null };
    case "machines":
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
    case "prs":
      return [
        "prs",
        screen.project.machineId,
        screen.project.projectId,
        ...(screen.pr === null ? [] : [...(screen.pr.repo === null ? [] : screen.pr.repo.split("/", 2)), String(screen.pr.number)]),
      ];
    case "agents":
      return screen.agent === null ? ["agents"] : ["agents", screen.agent.machineId, screen.agent.projectId, screen.agent.laneId];
    case "time":
      return screen.orderId === null ? ["time"] : ["time", "order", screen.orderId];
    case "projects.add":
      return ["projects", "add"];
    case "settings":
      return ["settings", screen.tab];
    case "status":
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
  const q = query.toString();
  return `#/${path(screen).map(encodeURIComponent).join("/")}${q === "" ? "" : `?${q}`}`;
};

/** An agent's key as the data layer's live agents name it: "machineId/projectId/laneId". */
export const agentId = (key: AgentKey): string => `${key.machineId}/${key.projectId}/${key.laneId}`;

export const sameProject = (a: ProjectKey | null, b: ProjectKey | null): boolean =>
  a === b || (a !== null && b !== null && a.machineId === b.machineId && a.projectId === b.projectId);
