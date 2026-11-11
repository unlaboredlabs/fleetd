// What the frame shows, as plain view data: the sidebar's projects with their two marks, the home project, the
// connection line. Pure, so it is unit-tested. The rows are the data layer's (selectShownProjects), in its order.
import type { HubState } from "../../../shared/hub";
import { RESTART_HOLD_MS } from "../../src/data/store";
import type { ProjectRow } from "../../src/data/selectors";
import type { ProjectKey } from "./routes";

/** Why a project wants you: a secret to enter, a command to approve, a reply, or something outside the work. */
export type WantWord = "secret" | "approve" | "reply" | "blocked";

export interface Want {
  /** Undefined while the lead waits on you but the open requests haven't loaded yet: the dot alone, no guess. */
  readonly word: WantWord | undefined;
  /** How many of that kind wait: secrets or approvals; 1 otherwise. */
  readonly count: number;
  /** The row's tooltip and accessible name for the mark. */
  readonly label: string;
}

/** A project row with the sidebar's two marks. */
export interface SidebarProject extends ProjectRow {
  /** Why it wants you now; undefined when it doesn't. */
  readonly want: Want | undefined;
  /** The lead's chat has a message newer than the one you last saw there. */
  readonly unread: boolean;
  /** Status's warning, which stops nothing: a check red on main, and whether a fix is under way. */
  readonly warning?: string | undefined;
  /** Its newest line (latest.ts): "You: ship it", "Asks for your approval"; empty while unknown or there is none. */
  readonly line: string;
  /** When that line was written, else when the chat or project last moved (ISO): the sidebar's order. */
  readonly at: string;
  /** You pinned it (pins.ts): on top, in your order, whatever moves. */
  readonly pinned: boolean;
  /** The section of yours it is in, by its id (sections.ts); undefined in none. A pinned one keeps it. */
  readonly section?: string | undefined;
}

/** The parts of an open request (requests_list) the marks count. */
export interface RequestIn {
  readonly projectRef: ProjectKey;
  readonly kind: "secret" | "approval";
  readonly state: string;
}

/** What the rows' marks read besides the project rows. */
export interface MarksIn {
  /** The hub's requests; undefined until read. Only open ones count. */
  readonly requests?: ReadonlyArray<RequestIn> | undefined;
  /** Status's blocked projects (status_get rows), by "machineId/projectId", with why. */
  readonly blocked?: ReadonlyMap<string, string | undefined> | undefined;
  /** Status's warnings (a red main), by "machineId/projectId". */
  readonly warnings?: ReadonlyMap<string, string> | undefined;
  /** The chat seq last seen per "machineId/projectId" (data/seen.ts). */
  readonly seen?: Readonly<Record<string, number>> | undefined;
  /** The project on screen: never unread. */
  readonly open?: ProjectKey | null | undefined;
  /** Each chat's newest line, by "machineId/projectId" (latest.ts). */
  readonly latest?: Readonly<Record<string, { readonly text: string; readonly at: string; readonly person?: { readonly id: string; readonly name: string } | undefined }>> | undefined;
  /** Who you are on this hub (hub_info's me): your own lines say "You:", a teammate's their first name. */
  readonly me?: string | undefined;
  /** The names the hub's people go by now, by person id (admin/names.ts): a teammate's line says the current one. */
  readonly names?: ReadonlyMap<string, string> | undefined;
  /** When each chat's newest message, of any kind, was written, by "machineId/projectId": the order before a line is known. */
  readonly lastAt?: Readonly<Record<string, string | undefined>> | undefined;
  /** Your pinned chats, by "machineId/projectId". */
  readonly pins?: readonly string[] | undefined;
  /** Your sections of chats, in your order (sections.ts). */
  readonly sections?: ReadonlyArray<{ readonly id: string; readonly chats: ReadonlyArray<ProjectKey> }> | undefined;
}

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** The most pressing reason first: a secret or an approval blocks a run now; a reply, then a block outside the work. */
const wantOf = ({ key, needsYou }: ProjectRow, marks: MarksIn): Want | undefined => {
  const open = marks.requests?.filter((r) => r.state === "open" && projectId(r.projectRef) === key);
  const secrets = open?.filter((r) => r.kind === "secret").length ?? 0;
  const approvals = open?.filter((r) => r.kind === "approval").length ?? 0;
  if (secrets > 0) return { word: "secret", count: secrets, label: `The lead needs ${plural(secrets, "secret", "secrets")} from you` };
  if (approvals > 0) return { word: "approve", count: approvals, label: `${plural(approvals, "command", "commands")} to approve` };
  if (needsYou) {
    return marks.requests === undefined
      ? { word: undefined, count: 1, label: "The lead is waiting on you" }
      : { word: "reply", count: 1, label: "The lead is waiting for your reply" };
  }
  if (marks.blocked?.has(key) === true) {
    const why = marks.blocked.get(key);
    return { word: "blocked", count: 1, label: why === undefined || why === "" ? "Blocked" : `Blocked: ${why}` };
  }
  return undefined;
};

/** Undefined until the projects loaded (startup, and after every link drop): not "no projects". */
export const toSidebar = (rows: ReadonlyArray<ProjectRow> | undefined, marks: MarksIn = {}): ReadonlyArray<SidebarProject> | undefined => {
  const open = marks.open == null ? null : projectId(marks.open);
  // A chat is in the first section that names it, as the hub keeps it.
  const section = new Map<string, string>();
  for (const s of marks.sections ?? []) for (const c of s.chats) if (!section.has(projectId(c))) section.set(projectId(c), s.id);
  return rows?.map((r): SidebarProject => {
    const seen = marks.seen?.[r.key];
    const unread = r.key !== open && r.lastSeq !== undefined && seen !== undefined && r.lastSeq > seen;
    const latest = marks.latest?.[r.key];
    const at = latest !== undefined && latest.at !== "" ? latest.at : (marks.lastAt?.[r.key] ?? r.project.lastActivityAt);
    const by = latest?.person;
    const name = by === undefined ? "" : (marks.names?.get(by.id) ?? by.name);
    const who = by === undefined || latest?.text === "" ? "" : by.id === "" || by.id === marks.me || name === "" ? "You: " : `${name.split(/\s+/u)[0] ?? name}: `;
    return { ...r, want: wantOf(r, marks), unread, warning: marks.warnings?.get(r.key), line: `${who}${latest?.text ?? ""}`, at, pinned: marks.pins?.includes(r.key) === true, section: section.get(r.key) };
  });
};

/** The route of a sidebar project. */
export const routeOf = (p: SidebarProject): ProjectKey => ({ machineId: p.project.machineId, projectId: p.project.projectId });

/**
 * The next project after `current` (a row's key) that wants you, in sidebar order and wrapping; null when no other one
 * does. Generic over the row, so the frame steps through every hub's rows at once (Shell.tsx).
 */
export const nextWanting = <P extends SidebarProject>(projects: ReadonlyArray<P>, current: string | null): P | null => {
  const at = current === null ? -1 : projects.findIndex((p) => p.key === current);
  for (let i = 1; i <= projects.length; i++) {
    const p = projects[(at + i) % projects.length];
    if (p !== undefined && p.want !== undefined && (at === -1 || p !== projects[at])) return p;
  }
  return null;
};

export const projectId = (key: ProjectKey): string => `${key.machineId}/${key.projectId}`;

/** The project before or after `current` (a row's key) in the sidebar, wrapping; the first (or last) when none is open. */
export const stepProject = <P extends SidebarProject>(projects: ReadonlyArray<P>, current: string | null, by: 1 | -1): P | null => {
  if (projects.length === 0) return null;
  const at = current === null ? -1 : projects.findIndex((p) => p.key === current);
  const p = at === -1 ? (by === 1 ? projects[0] : projects.at(-1)) : projects[(at + by + projects.length) % projects.length];
  return p ?? null;
};

/**
 * Where `#/` goes: the project you last had open (its row's key) when it still exists, else the first in the sidebar;
 * null when there are no projects (the frame offers to add one).
 */
export const homeProject = <P extends SidebarProject>(projects: ReadonlyArray<P>, last: string | null): P | null =>
  projects.find((x) => x.key === last) ?? projects[0] ?? null;

/** An update's restart that runs longer than this gets the main area's one line (updates/RestartLine). */
export const LONG_RESTART_MS = 30_000;
/** And one longer than this is an outage: the offline banner, as for any lost link. */
export const OUTAGE_MS = 120_000;

export type RestartPhase = "quiet" | "long" | "outage";

export interface Restart {
  readonly phase: RestartPhase;
  readonly since: number;
  /** The build an update restarts into; null for a restart or stop that isn't an update. */
  readonly to: string | null;
}

/**
 * Where a restart stands: null when the hub didn't close to restart (connected, or any other drop). An update's is
 * quiet for 30 s, then long until 2 minutes; any other restart or stop is quiet only while the screens hold what they
 * showed (RESTART_HOLD_MS), then an outage like any lost link.
 */
export const restartOf = (hub: HubState, now: number): Restart | null => {
  if ((hub.phase !== "connecting" && hub.phase !== "retrying") || hub.restarting === undefined) return null;
  const away = now - hub.restarting;
  const to = hub.updatingTo ?? null;
  const phase = to === null ? (away < RESTART_HOLD_MS ? "quiet" : "outage") : away < LONG_RESTART_MS ? "quiet" : away < OUTAGE_MS ? "long" : "outage";
  return { phase, since: hub.restarting, to };
};

/** `http://100.64.0.1:4790/` → `100.64.0.1:4790`. */
const host = (hub: string): string => hub.replace(/^[a-z]+:\/\//iu, "").replace(/\/.*$/u, "");

/**
 * What the sidebar calls a hub: the first label of its host (`https://devbox.example.ts.net:4790` → `devbox`). An
 * address has no such label, so it stays whole, without its port (`100.64.0.1`, `[fd7a::1]`).
 */
export const hubName = (hub: string): string => {
  const h = host(hub);
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  const bare = h.replace(/:\d*$/u, "");
  if (/^\d+(?:\.\d+){3}$/u.test(bare)) return bare;
  return bare.split(".")[0] ?? bare;
};
